import fetch from 'node-fetch';
import fs from 'fs/promises';
import path from 'path';
import { config } from '../config.js';
import { sanitizeForFilename } from '../utils/helpers.js';
import { logger } from '../logger.js';

const fileExists = async (filePath) => {
    try {
        await fs.access(filePath);
        return true;
    } catch {
        return false;
    }
};

export class ImageService {
    constructor() {
        const storageRoot = path.resolve(config.storagePath);
        this.imagesRoot = path.join(path.dirname(storageRoot), 'images');
    }

    buildAlbumCoverPath(albumId) {
        const safeId = sanitizeForFilename(String(albumId));
        return path.join(this.imagesRoot, 'albums', safeId, 'cover.jpg');
    }

    buildArtistPicturePath(artistId) {
        const safeId = sanitizeForFilename(String(artistId));
        return path.join(this.imagesRoot, 'artists', safeId, 'photo.jpg');
    }

    async ensureAlbumCover({ albumId, coverUrl, fallbackCoverPath }) {
        if (!albumId) return null;
        const targetPath = this.buildAlbumCoverPath(albumId);

        if (await fileExists(targetPath)) {
            return targetPath;
        }

        if (fallbackCoverPath && (await fileExists(fallbackCoverPath))) {
            try {
                await fs.mkdir(path.dirname(targetPath), { recursive: true });
                await fs.copyFile(fallbackCoverPath, targetPath);
                return targetPath;
            } catch (error) {
                logger.warn(`Failed to copy album cover: ${error.message}`);
            }
        }

        if (!coverUrl) return null;

        try {
            const response = await fetch(coverUrl);
            if (!response.ok) {
                logger.warn(`Failed to download album cover: HTTP ${response.status}`);
                return null;
            }
            const buffer = await response.arrayBuffer();
            await fs.mkdir(path.dirname(targetPath), { recursive: true });
            await fs.writeFile(targetPath, Buffer.from(buffer));
            return targetPath;
        } catch (error) {
            logger.warn(`Failed to download album cover: ${error.message}`);
            return null;
        }
    }

    async ensureArtistPicture({ artistId, pictureUrl }) {
        if (!artistId || !pictureUrl) return null;
        const targetPath = this.buildArtistPicturePath(artistId);

        if (await fileExists(targetPath)) {
            return targetPath;
        }

        try {
            const response = await fetch(pictureUrl);
            if (!response.ok) {
                logger.warn(`Failed to download artist picture: HTTP ${response.status}`);
                return null;
            }
            const buffer = await response.arrayBuffer();
            await fs.mkdir(path.dirname(targetPath), { recursive: true });
            await fs.writeFile(targetPath, Buffer.from(buffer));
            return targetPath;
        } catch (error) {
            logger.warn(`Failed to download artist picture: ${error.message}`);
            return null;
        }
    }
}
