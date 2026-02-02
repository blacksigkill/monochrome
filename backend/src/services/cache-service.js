import fs from 'fs/promises';
import path from 'path';
import { config } from '../config.js';
import { logger } from '../logger.js';

export class CacheService {
    constructor() {
        this.storagePath = path.resolve(config.storagePath);
    }

    async ensureStorageDir() {
        try {
            await fs.mkdir(this.storagePath, { recursive: true });
        } catch (error) {
            logger.error(`Failed to create storage directory: ${error.message}`);
            throw error;
        }
    }

    async checkCache(trackId, quality) {
        try {
            const metadataPath = path.join(this.storagePath, `${trackId}.json`);
            const metadataContent = await fs.readFile(metadataPath, 'utf-8');
            const metadata = JSON.parse(metadataContent);

            if (metadata.quality === quality) {
                const audioPath = metadata.filePath;
                try {
                    await fs.access(audioPath);
                    return audioPath;
                } catch {
                    // File doesn't exist, cache invalid
                    return null;
                }
            }

            return null;
        } catch {
            return null;
        }
    }

    async saveCache(trackId, quality, filePath) {
        try {
            const metadataPath = path.join(this.storagePath, `${trackId}.json`);
            const metadata = {
                trackId,
                quality,
                filePath,
                downloadedAt: new Date().toISOString(),
            };

            await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2));
        } catch (error) {
            logger.warn(`Failed to save cache metadata: ${error.message}`);
        }
    }
}
