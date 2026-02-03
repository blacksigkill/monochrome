import fetch from 'node-fetch';
import fs from 'fs/promises';
import path from 'path';
import { APIService } from './api-service.js';
import { CacheService } from './cache-service.js';
import { DashDownloader } from './dash-downloader.js';
import { ImageService } from './image-service.js';
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
        this.imageService = new ImageService();
        this.activeDownloads = new Map();
        this.activeMetadataRefresh = new Set();
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
                const trackMeta = this.metadataService.getTrackMetadata(trackId);
                const albumId = trackMeta ? this.resolveAlbumId(trackMeta, null) : null;
                const artistId = trackMeta ? this.resolveArtistId(trackMeta) : null;
                const needsAlbumMeta = albumId && !this.metadataService.getAlbumMetadata(albumId);
                const needsArtistMeta = artistId && !this.metadataService.getArtistMetadata(artistId);

                if (!trackMeta || needsAlbumMeta || needsArtistMeta) {
                    void this.refreshMetadata(apiInstances, trackId, trackMeta, albumId, cached);
                }
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
            const coverPath = await this.enrichMetadata(apiService, track, metadata, filePath);

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

    resolveAlbumId(track, metadata) {
        return (
            metadata?.albumId || track?.album?.id || track?.albumId || track?.album_id || track?.album?.albumId || null
        );
    }

    resolveArtistId(track) {
        if (track?.artist?.id) return track.artist.id;
        if (Array.isArray(track?.artists) && track.artists.length > 0) {
            return track.artists[0]?.id || null;
        }
        return null;
    }

    resolveArtistName(track, metadata) {
        if (metadata?.albumArtist) return metadata.albumArtist;
        if (metadata?.artist) return metadata.artist;
        if (track?.artist?.name) return track.artist.name;
        if (Array.isArray(track?.artists) && track.artists.length > 0) {
            return track.artists[0]?.name || null;
        }
        return null;
    }

    resolveAlbumTitle(track, metadata) {
        return metadata?.albumTitle || track?.album?.title || track?.album?.name || null;
    }

    resolveCoverIdFromTrack(track) {
        const album = track?.album || {};
        return (
            album.cover ||
            album.coverId ||
            album.cover_id ||
            album.image ||
            album.cover?.id ||
            track?.coverId ||
            track?.cover_id ||
            null
        );
    }

    async enrichMetadata(apiService, track, metadata, trackPath) {
        const albumId = this.resolveAlbumId(track, metadata);
        const artistId = this.resolveArtistId(track);
        const albumTitle = this.resolveAlbumTitle(track, metadata);
        const artistName = this.resolveArtistName(track, metadata);

        let coverPath = null;
        let albumDir = this.imageService.resolveAlbumDir({
            trackPath,
            artistName,
            albumTitle,
        });

        if (albumId) {
            let albumRecord = null;
            try {
                const albumPayload = await apiService.getAlbumMetadata(albumId);
                albumRecord = this.metadataService.upsertAlbumMetadata(albumId, albumPayload);
            } catch (error) {
                logger.warn(`Failed to persist album metadata for ${albumId}: ${error.message}`);
            }

            const coverId = albumRecord?.coverId || this.resolveCoverIdFromTrack(track);
            const coverUrl = albumRecord?.coverUrl || metadata?.coverUrl || null;
            const resolvedArtistName = albumRecord?.artist || artistName;
            const resolvedAlbumTitle = albumRecord?.title || albumTitle;

            const albumAssets = await this.imageService.ensureAlbumImages({
                albumId,
                artistName: resolvedArtistName,
                albumTitle: resolvedAlbumTitle,
                coverId,
                coverUrl,
                trackPath,
            });

            if (albumAssets.length > 0) {
                albumDir = albumAssets[0].albumDir || albumDir;
                albumAssets.forEach((asset) => {
                    this.metadataService.upsertImageAsset({
                        ownerType: 'album',
                        ownerId: albumId,
                        kind: 'cover',
                        size: asset.size,
                        url: asset.url,
                        filePath: asset.filePath,
                    });
                });

                const candidateCoverPath = this.imageService.buildAlbumImagePath(albumDir, null);
                if (candidateCoverPath && (await this.fileExists(candidateCoverPath))) {
                    coverPath = candidateCoverPath;
                    this.metadataService.updateAlbumCoverPath(albumId, candidateCoverPath);
                }
            }
        }

        if (artistId) {
            let artistRecord = null;
            try {
                const artistPayload = await apiService.getArtistMetadata(artistId);
                artistRecord = this.metadataService.upsertArtistMetadata(artistId, artistPayload);
            } catch (error) {
                logger.warn(`Failed to persist artist metadata for ${artistId}: ${error.message}`);
            }

            const resolvedArtistName = artistRecord?.name || artistName;
            const pictureId = artistRecord?.pictureId || null;
            const pictureUrl = artistRecord?.pictureUrl || null;
            const artistAssets = await this.imageService.ensureArtistImages({
                artistId,
                artistName: resolvedArtistName,
                pictureId,
                pictureUrl,
                albumDir,
            });

            if (artistAssets.length > 0) {
                const artistDir = artistAssets[0].artistDir;
                artistAssets.forEach((asset) => {
                    this.metadataService.upsertImageAsset({
                        ownerType: 'artist',
                        ownerId: artistId,
                        kind: 'picture',
                        size: asset.size,
                        url: asset.url,
                        filePath: asset.filePath,
                    });
                });

                const candidatePicturePath = this.imageService.buildArtistImagePath(artistDir, null);
                if (candidatePicturePath && (await this.fileExists(candidatePicturePath))) {
                    this.metadataService.updateArtistPicturePath(artistId, candidatePicturePath);
                }
            }
        }

        return coverPath;
    }

    async refreshMetadata(apiInstances, trackId, trackMeta, albumId, trackPath) {
        if (this.activeMetadataRefresh.has(trackId)) return;
        this.activeMetadataRefresh.add(trackId);

        try {
            const apiService = new APIService(apiInstances);
            const track = trackMeta || (await apiService.getTrackMetadata(trackId));
            const metadata = this.metadataService.upsertTrackMetadata(trackId, track || {});

            const resolvedAlbumId = albumId || this.resolveAlbumId(track, metadata);
            const fallbackPath =
                trackPath || (resolvedAlbumId ? this.cacheService.getAlbumCoverPath(resolvedAlbumId) : null);

            await this.enrichMetadata(apiService, track, metadata, fallbackPath);
        } catch (error) {
            logger.warn(`Failed to refresh metadata for ${trackId}: ${error.message}`);
        } finally {
            this.activeMetadataRefresh.delete(trackId);
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
