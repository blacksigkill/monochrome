import fs from 'fs/promises';
import path from 'path';
import { config } from '../config.js';
import { db } from '../db/index.js';
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
        const row = db.prepare('SELECT file_path FROM files WHERE track_id = ? AND quality = ?').get(trackId, quality);

        if (row?.file_path) {
            try {
                await fs.access(row.file_path);
                return row.file_path;
            } catch {
                this.removeFileRecord(trackId, quality);
            }
        }
        return null;
    }

    async saveCache({ trackId, quality, filePath, sizeBytes, extension, albumId, coverPath }) {
        try {
            const now = new Date().toISOString();

            db.prepare(
                `
                    INSERT INTO files (track_id, album_id, quality, extension, file_path, cover_path, size_bytes, downloaded_at)
                    VALUES (@trackId, @albumId, @quality, @extension, @filePath, @coverPath, @sizeBytes, @downloadedAt)
                    ON CONFLICT(track_id, quality) DO UPDATE SET
                        album_id = excluded.album_id,
                        extension = excluded.extension,
                        file_path = excluded.file_path,
                        cover_path = excluded.cover_path,
                        size_bytes = excluded.size_bytes,
                        downloaded_at = excluded.downloaded_at
                `
            ).run({
                trackId,
                albumId: albumId || null,
                quality,
                extension: extension || null,
                filePath,
                coverPath: coverPath || null,
                sizeBytes: sizeBytes || null,
                downloadedAt: now,
            });
        } catch (error) {
            logger.warn(`Failed to save cache metadata: ${error.message}`);
        }
    }

    getAlbumCoverPath(albumId) {
        if (!albumId) return null;
        const row = db
            .prepare('SELECT cover_path FROM files WHERE album_id = ? AND cover_path IS NOT NULL LIMIT 1')
            .get(albumId);
        return row?.cover_path || null;
    }

    removeFileRecord(trackId, quality) {
        try {
            db.prepare('DELETE FROM files WHERE track_id = ? AND quality = ?').run(trackId, quality);
        } catch (error) {
            logger.warn(`Failed to remove file record: ${error.message}`);
        }
    }
}
