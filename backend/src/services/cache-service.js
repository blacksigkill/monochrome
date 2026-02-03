import fs from 'fs/promises';
import path from 'path';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { logger } from '../logger.js';

export class CacheService {
    constructor() {
        this.storagePath = path.resolve(config.storagePath);
    }

    normalizeTrackId(trackId) {
        if (trackId === null || trackId === undefined) return '';
        return String(trackId).trim();
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
        const normalizedId = this.normalizeTrackId(trackId);
        const numericId = Number.parseInt(normalizedId, 10);
        const hasNumeric = Number.isFinite(numericId) && String(numericId) === normalizedId;

        const row = hasNumeric
            ? db
                  .prepare('SELECT file_path FROM files WHERE (track_id = ? OR track_id = ?) AND quality = ?')
                  .get(normalizedId, numericId, quality)
            : db.prepare('SELECT file_path FROM files WHERE track_id = ? AND quality = ?').get(normalizedId, quality);

        if (row?.file_path) {
            try {
                await fs.access(row.file_path);
                return row.file_path;
            } catch {
                this.removeFileRecord(normalizedId, quality);
            }
        }
        return null;
    }

    async checkAnyCache(trackId) {
        const normalizedId = this.normalizeTrackId(trackId);
        const numericId = Number.parseInt(normalizedId, 10);
        const hasNumeric = Number.isFinite(numericId) && String(numericId) === normalizedId;

        const rows = hasNumeric
            ? db
                  .prepare(
                      'SELECT file_path, quality FROM files WHERE (track_id = ? OR track_id = ?) ORDER BY downloaded_at DESC'
                  )
                  .all(normalizedId, numericId)
            : db
                  .prepare('SELECT file_path, quality FROM files WHERE track_id = ? ORDER BY downloaded_at DESC')
                  .all(normalizedId);

        if (!rows || rows.length === 0) return null;

        for (const row of rows) {
            if (!row?.file_path) continue;
            try {
                await fs.access(row.file_path);
                return { filePath: row.file_path, quality: row.quality };
            } catch {
                this.removeFileRecord(normalizedId, row.quality);
            }
        }

        return null;
    }

    async saveCache({ trackId, quality, filePath, sizeBytes, extension, albumId, coverPath }) {
        try {
            const now = new Date().toISOString();
            const normalizedId = this.normalizeTrackId(trackId);

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
                trackId: normalizedId,
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
            const normalizedId = this.normalizeTrackId(trackId);
            const numericId = Number.parseInt(normalizedId, 10);
            const hasNumeric = Number.isFinite(numericId) && String(numericId) === normalizedId;

            if (hasNumeric) {
                db.prepare('DELETE FROM files WHERE (track_id = ? OR track_id = ?) AND quality = ?').run(
                    normalizedId,
                    numericId,
                    quality
                );
            } else {
                db.prepare('DELETE FROM files WHERE track_id = ? AND quality = ?').run(normalizedId, quality);
            }
        } catch (error) {
            logger.warn(`Failed to remove file record: ${error.message}`);
        }
    }
}
