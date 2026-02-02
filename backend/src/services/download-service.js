import fetch from 'node-fetch';
import fs from 'fs/promises';
import path from 'path';
import { APIService } from './api-service.js';
import { CacheService } from './cache-service.js';
import { DashDownloader } from './dash-downloader.js';
import { config } from '../config.js';
import { detectExtension } from '../utils/helpers.js';
import { logger } from '../logger.js';

export class DownloadService {
    constructor() {
        this.cacheService = new CacheService();
        this.activeDownloads = new Map();
    }

    async downloadTrack(trackId, quality, apiInstances) {
        if (!apiInstances || apiInstances.length === 0) {
            throw new Error('API instances are required');
        }

        await this.cacheService.ensureStorageDir();

        const downloadKey = this.getDownloadKey(trackId, quality);
        try {
            // Check if already downloading
            if (this.activeDownloads.has(downloadKey)) {
                logger.info(`Track ${trackId} already downloading, skipping duplicate request`);
                return { status: 'downloading', trackId };
            }

            // Check cache
            const cached = await this.cacheService.checkCache(trackId, quality);
            if (cached) {
                logger.info(`Track ${trackId} already cached at ${cached}`);
                return { status: 'cached', path: cached, trackId };
            }

            // Mark as downloading
            this.activeDownloads.set(downloadKey, true);

            logger.info(`Starting download for track ${trackId} at quality ${quality}`);

            // Create API service with provided instances
            const apiService = new APIService(apiInstances);

            const { buffer, ext } = await this.fetchTrackBuffer(apiService, trackId, quality);
            const resolvedExt = ext || detectExtension(buffer);

            const filePath = path.join(path.resolve(config.storagePath), `${trackId}.${resolvedExt}`);

            await fs.writeFile(filePath, buffer);
            logger.info(`Track ${trackId} saved to ${filePath} (${(buffer.length / 1024 / 1024).toFixed(2)} MB)`);

            await this.cacheService.saveCache(trackId, quality, filePath);

            return { status: 'downloaded', path: filePath, size: buffer.length, trackId };
        } catch (error) {
            logger.error(`Failed to download track ${trackId}: ${error.message}`);
            throw error;
        } finally {
            this.activeDownloads.delete(downloadKey);
        }
    }

    async getStatus(trackId, quality) {
        // Check if downloading
        if (this.activeDownloads.has(this.getDownloadKey(trackId, quality))) {
            return { status: 'downloading', trackId };
        }

        // Check cache
        const cached = await this.cacheService.checkCache(trackId, quality);
        if (cached) {
            return { status: 'cached', path: cached, trackId };
        }

        return { status: 'not_found', trackId };
    }

    getDownloadKey(trackId, quality) {
        return `${trackId}_${quality}`;
    }

    async fetchTrackBuffer(apiService, trackId, quality) {
        const trackData = await apiService.getTrack(trackId, quality);
        const manifestContent = apiService.decodeManifest(trackData.info?.manifest);

        if (apiService.isDashManifest(manifestContent)) {
            logger.info(`Track ${trackId} uses DASH manifest, downloading segments`);
            const dashDownloader = new DashDownloader();
            const buffer = await dashDownloader.downloadDashStream(manifestContent);
            return { buffer, ext: 'mp4' };
        }

        const streamUrl = trackData.originalTrackUrl || apiService.extractStreamUrlFromDecodedManifest(manifestContent);

        if (!streamUrl) {
            throw new Error('Could not resolve stream URL from manifest');
        }

        logger.info(`Fetching stream for track ${trackId}`);
        const buffer = await this.fetchBuffer(streamUrl);
        return { buffer, ext: detectExtension(buffer) };
    }

    async fetchBuffer(url) {
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`Stream fetch failed with status ${response.status}`);
        }
        const buffer = await response.arrayBuffer();
        return Buffer.from(buffer);
    }
}
