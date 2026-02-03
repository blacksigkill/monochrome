import fetch from 'node-fetch';
import fs from 'fs/promises';
import path from 'path';
import { APIService } from './api-service.js';
import { CacheService } from './cache-service.js';
import { DashDownloader } from './dash-downloader.js';
import { MetadataService } from './metadata-service.js';
import { PreferencesService } from './preferences-service.js';
import { config } from '../config.js';
import { buildTrackFilename, detectExtension, sanitizeForFilename } from '../utils/helpers.js';
import { logger } from '../logger.js';

export class DownloadService {
    constructor() {
        this.cacheService = new CacheService();
        this.metadataService = new MetadataService();
        this.preferencesService = new PreferencesService();
        this.activeDownloads = new Map();
    }

    async downloadTrack(trackId, quality, apiInstances) {
        if (!apiInstances || apiInstances.length === 0) {
            throw new Error('API instances are required');
        }

        await this.cacheService.ensureStorageDir();

        const resolvedQuality = await this.resolveDownloadQuality(quality);
        const downloadKey = this.getDownloadKey(trackId, resolvedQuality);
        try {
            // Check if already downloading
            if (this.activeDownloads.has(downloadKey)) {
                logger.info(`Track ${trackId} already downloading, skipping duplicate request`);
                return { status: 'downloading', trackId };
            }

            // Check cache
            const cached = await this.cacheService.checkCache(trackId, resolvedQuality);
            if (cached) {
                logger.info(`Track ${trackId} already cached at ${cached}`);
                return { status: 'cached', path: cached, trackId };
            }

            // Mark as downloading
            this.activeDownloads.set(downloadKey, true);

            logger.info(`Starting download for track ${trackId} at quality ${resolvedQuality}`);

            // Create API service with provided instances
            const apiService = new APIService(apiInstances);

            const { buffer, ext, track } = await this.fetchTrackBuffer(apiService, trackId, resolvedQuality);
            let metadata = null;
            try {
                metadata = this.metadataService.upsertTrackMetadata(trackId, track || {});
            } catch (error) {
                logger.warn(`Failed to persist metadata for track ${trackId}: ${error.message}`);
            }
            const resolvedExt = ext || detectExtension(buffer);
            const relativePath = await this.buildFilename(track, metadata, resolvedExt, trackId);
            const filePath = await this.resolveOutputPath(relativePath, trackId, resolvedExt);
            const coverPath = await this.ensureCover(metadata, path.dirname(filePath));

            await fs.writeFile(filePath, buffer);
            logger.info(`Track ${trackId} saved to ${filePath} (${(buffer.length / 1024 / 1024).toFixed(2)} MB)`);

            await this.cacheService.saveCache({
                trackId,
                quality: resolvedQuality,
                filePath,
                sizeBytes: buffer.length,
                extension: resolvedExt,
                albumId: metadata?.albumId,
                coverPath,
            });

            return {
                status: 'downloaded',
                path: filePath,
                size: buffer.length,
                trackId,
                quality: resolvedQuality,
            };
        } catch (error) {
            logger.error(`Failed to download track ${trackId}: ${error.message}`);
            throw error;
        } finally {
            this.activeDownloads.delete(downloadKey);
        }
    }

    async getStatus(trackId, quality) {
        const resolvedQuality = await this.resolveDownloadQuality(quality);
        // Check if downloading
        if (this.activeDownloads.has(this.getDownloadKey(trackId, resolvedQuality))) {
            return { status: 'downloading', trackId };
        }

        // Check cache
        const cached = await this.cacheService.checkCache(trackId, resolvedQuality);
        if (cached) {
            return { status: 'cached', path: cached, trackId };
        }

        return { status: 'not_found', trackId };
    }

    async getCachedFile(trackId, quality, { fallback = false } = {}) {
        const resolvedQuality = await this.resolveDownloadQuality(quality);
        const cached = await this.cacheService.checkCache(trackId, resolvedQuality);
        if (cached) {
            return {
                status: 'cached',
                path: cached,
                trackId,
                quality: resolvedQuality,
                fallback: false,
            };
        }

        if (!fallback) {
            return { status: 'not_found', trackId };
        }

        const anyCached = await this.cacheService.checkAnyCache(trackId);
        if (anyCached?.filePath) {
            return {
                status: 'cached',
                path: anyCached.filePath,
                trackId,
                quality: anyCached.quality,
                fallback: true,
            };
        }

        return { status: 'not_found', trackId };
    }

    getDownloadKey(trackId, quality) {
        return `${trackId}_${quality}`;
    }

    async fetchTrackBuffer(apiService, trackId, quality) {
        const trackData = await apiService.getTrack(trackId, quality);
        const manifestContent = apiService.decodeManifest(trackData.info?.manifest);
        const track = await this.resolveTrackMetadata(apiService, trackData.track, trackId);

        if (apiService.isDashManifest(manifestContent)) {
            logger.info(`Track ${trackId} uses DASH manifest, downloading segments`);
            const dashDownloader = new DashDownloader();
            const buffer = await dashDownloader.downloadDashStream(manifestContent);
            return { buffer, ext: 'mp4', track };
        }

        const streamUrl = trackData.originalTrackUrl || apiService.extractStreamUrlFromDecodedManifest(manifestContent);

        if (!streamUrl) {
            throw new Error('Could not resolve stream URL from manifest');
        }

        logger.info(`Fetching stream for track ${trackId}`);
        const buffer = await this.fetchBuffer(streamUrl);
        return { buffer, ext: detectExtension(buffer), track };
    }

    async fetchBuffer(url) {
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`Stream fetch failed with status ${response.status}`);
        }
        const buffer = await response.arrayBuffer();
        return Buffer.from(buffer);
    }

    async buildFilename(track, metadata, extension, trackId) {
        const preferences = await this.preferencesService.getPreferences();
        const normalizedTrack = this.mergeMetadataIntoTrack(track || {}, metadata);
        const filename = buildTrackFilename(normalizedTrack, preferences.filenameTemplate, extension);
        return this.normalizeRelativePath(filename, extension, trackId);
    }

    async resolveOutputPath(relativePath, trackId, extension) {
        const outputDir = path.resolve(config.storagePath);
        const safeRelativePath = this.normalizeRelativePath(relativePath, extension, trackId);
        let candidate = path.join(outputDir, safeRelativePath);
        candidate = this.ensureWithinOutputDir(candidate, outputDir, trackId, extension);

        if (!(await this.fileExists(candidate))) {
            await fs.mkdir(path.dirname(candidate), { recursive: true });
            return candidate;
        }

        const directory = path.dirname(candidate);
        const baseName = path.basename(candidate);
        const ext = path.extname(baseName);
        const name = path.basename(baseName, ext);
        const withTrackId = path.join(directory, `${name}-${trackId}${ext}`);
        candidate = this.ensureWithinOutputDir(withTrackId, outputDir, trackId, extension);

        if (!(await this.fileExists(candidate))) {
            await fs.mkdir(path.dirname(candidate), { recursive: true });
            return candidate;
        }

        for (let index = 2; index < 1000; index += 1) {
            const attempt = this.ensureWithinOutputDir(
                path.join(directory, `${name}-${trackId}-${index}${ext}`),
                outputDir,
                trackId,
                extension
            );
            if (!(await this.fileExists(attempt))) {
                await fs.mkdir(path.dirname(attempt), { recursive: true });
                return attempt;
            }
        }

        return candidate;
    }

    async ensureCover(metadata, targetDir) {
        const coverUrl = metadata?.coverUrl;
        if (!coverUrl || !targetDir) return null;

        const targetPath = path.join(targetDir, 'cover.jpg');

        if (await this.fileExists(targetPath)) {
            return targetPath;
        }

        const existingCover = metadata.albumId ? this.cacheService.getAlbumCoverPath(metadata.albumId) : null;
        if (existingCover && (await this.fileExists(existingCover))) {
            await fs.mkdir(targetDir, { recursive: true });
            await fs.copyFile(existingCover, targetPath);
            return targetPath;
        }

        try {
            const response = await fetch(coverUrl);
            if (!response.ok) {
                logger.warn(`Failed to download cover art: HTTP ${response.status}`);
                return null;
            }
            const buffer = await response.arrayBuffer();
            await fs.mkdir(targetDir, { recursive: true });
            await fs.writeFile(targetPath, Buffer.from(buffer));
            return targetPath;
        } catch (error) {
            logger.warn(`Failed to download cover art: ${error.message}`);
            return null;
        }
    }

    normalizeRelativePath(relativePath, extension, trackId) {
        const raw = typeof relativePath === 'string' ? relativePath : '';
        const normalized = raw.replace(/\\/g, '/');
        const segments = normalized
            .split('/')
            .map((segment) => segment.trim())
            .filter(Boolean)
            .filter((segment) => segment !== '.' && segment !== '..')
            .map((segment) => sanitizeForFilename(segment));

        if (segments.length === 0) {
            return `${trackId}.${extension}`;
        }

        const safePath = segments.join(path.sep);
        const baseName = path.basename(safePath);
        if (!baseName || baseName === `.${extension}`) {
            const fallbackName = `${trackId}.${extension}`;
            const dir = path.dirname(safePath);
            return dir === '.' ? fallbackName : path.join(dir, fallbackName);
        }

        return safePath;
    }

    mergeMetadataIntoTrack(track, metadata) {
        if (!metadata) return track;

        const merged = { ...track };
        if (!merged.title && metadata.title) {
            merged.title = metadata.title;
        }

        if (!merged.artist && metadata.artist) {
            merged.artist = { name: metadata.artist };
        } else if (typeof merged.artist === 'string') {
            merged.artist = { name: merged.artist };
        }

        const hasArtistObjects =
            Array.isArray(merged.artists) && merged.artists.some((artist) => artist && typeof artist === 'object');

        if ((!merged.artists || !hasArtistObjects) && metadata.artist) {
            merged.artists = [{ name: metadata.artist }];
        }

        if (!merged.album || typeof merged.album !== 'object') {
            merged.album = {};
        }

        if (!merged.album.title && metadata.albumTitle) {
            merged.album.title = metadata.albumTitle;
        }

        if (!merged.album.artist && metadata.albumArtist) {
            merged.album.artist = { name: metadata.albumArtist };
        } else if (typeof merged.album.artist === 'string') {
            merged.album.artist = { name: merged.album.artist };
        }

        return merged;
    }

    ensureWithinOutputDir(candidate, outputDir, trackId, extension) {
        const resolved = path.resolve(candidate);
        if (resolved === outputDir || resolved.startsWith(`${outputDir}${path.sep}`)) {
            return resolved;
        }

        return path.join(outputDir, `${trackId}.${extension}`);
    }

    async resolveDownloadQuality(requestedQuality) {
        const preferences = await this.preferencesService.getPreferences();
        const preferredQuality = preferences.downloadQuality;

        if (preferredQuality && preferredQuality !== 'player') {
            return preferredQuality;
        }

        return requestedQuality || 'HI_RES_LOSSLESS';
    }

    async resolveTrackMetadata(apiService, track, trackId) {
        const hasArtist = track?.artist?.name || (Array.isArray(track?.artists) && track.artists.length > 0);
        const hasTitle = track?.title || track?.name;
        const hasAlbum = track?.album?.title || track?.album?.name;

        if (hasArtist && hasTitle && hasAlbum) {
            return track;
        }

        try {
            return await apiService.getTrackMetadata(trackId);
        } catch (error) {
            logger.warn(`Failed to fetch metadata for track ${trackId}: ${error.message}`);
            return track || {};
        }
    }

    async fileExists(filePath) {
        try {
            await fs.access(filePath);
            return true;
        } catch {
            return false;
        }
    }
}
