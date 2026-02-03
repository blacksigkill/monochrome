import fetch from 'node-fetch';
import fs from 'fs/promises';
import path from 'path';
import { config } from '../config.js';
import { getArtistPictureUrl, getCoverUrl, sanitizeForFilename } from '../utils/helpers.js';
import { logger } from '../logger.js';

const DEFAULT_SIZES = [320, 640, 1280];

const fileExists = async (filePath) => {
    try {
        await fs.access(filePath);
        return true;
    } catch {
        return false;
    }
};

const ensureDir = async (dirPath) => {
    if (!dirPath) return;
    await fs.mkdir(dirPath, { recursive: true });
};

export class ImageService {
    constructor() {
        this.storageRoot = path.resolve(config.storagePath);
    }

    buildArtistDir(artistName) {
        if (!artistName) return null;
        const safeArtist = sanitizeForFilename(String(artistName));
        return path.join(this.storageRoot, safeArtist);
    }

    buildAlbumDir(artistName, albumTitle) {
        if (!artistName || !albumTitle) return null;
        const safeArtist = sanitizeForFilename(String(artistName));
        const safeAlbum = sanitizeForFilename(String(albumTitle));
        return path.join(this.storageRoot, safeArtist, safeAlbum);
    }

    resolveAlbumDir({ trackPath, artistName, albumTitle }) {
        if (trackPath) {
            const candidate = path.dirname(trackPath);
            if (candidate && candidate !== this.storageRoot) return candidate;
        }

        return this.buildAlbumDir(artistName, albumTitle);
    }

    resolveArtistDir({ albumDir, artistName }) {
        if (albumDir) {
            const candidate = path.dirname(albumDir);
            if (candidate && candidate !== this.storageRoot) return candidate;
        }

        return this.buildArtistDir(artistName);
    }

    buildAlbumImagePath(albumDir, size) {
        if (!albumDir) return null;
        if (!size) return path.join(albumDir, 'cover.jpg');
        return path.join(albumDir, `cover_${size}.jpg`);
    }

    buildArtistImagePath(artistDir, size) {
        if (!artistDir) return null;
        const baseDir = path.join(artistDir, 'artist');
        if (!size) return `${baseDir}.jpg`;
        return `${baseDir}_${size}.jpg`;
    }

    async downloadImage(url, targetPath) {
        if (!url || !targetPath) return false;

        if (await fileExists(targetPath)) {
            return true;
        }

        try {
            const response = await fetch(url);
            if (!response.ok) {
                logger.warn(`Failed to download image: HTTP ${response.status}`);
                return false;
            }
            const buffer = await response.arrayBuffer();
            await ensureDir(path.dirname(targetPath));
            await fs.writeFile(targetPath, Buffer.from(buffer));
            return true;
        } catch (error) {
            logger.warn(`Failed to download image: ${error.message}`);
            return false;
        }
    }

    async ensureAlbumImages({
        albumId,
        artistName,
        albumTitle,
        coverId,
        coverUrl,
        sizes = DEFAULT_SIZES,
        trackPath,
        fallbackCoverPath,
    }) {
        if (!albumId) return [];

        const albumDir = this.resolveAlbumDir({ trackPath, artistName, albumTitle });
        if (!albumDir) return [];

        const assets = [];
        const uniqueSizes = Array.from(new Set(sizes.filter((value) => Number.isFinite(value))));

        if (coverId) {
            for (const size of uniqueSizes) {
                const url = getCoverUrl(coverId, size);
                const targetPath = this.buildAlbumImagePath(albumDir, size);
                const ok = await this.downloadImage(url, targetPath);
                if (ok) {
                    assets.push({ size, url, filePath: targetPath });
                }
            }
        } else if (coverUrl) {
            const targetPath = this.buildAlbumImagePath(albumDir, null);
            const ok = await this.downloadImage(coverUrl, targetPath);
            if (ok) {
                assets.push({ size: null, url: coverUrl, filePath: targetPath });
            }
        }

        if (assets.length === 0 && fallbackCoverPath && (await fileExists(fallbackCoverPath))) {
            const targetPath = this.buildAlbumImagePath(albumDir, null);
            try {
                await ensureDir(path.dirname(targetPath));
                await fs.copyFile(fallbackCoverPath, targetPath);
                assets.push({ size: null, url: null, filePath: targetPath });
            } catch (error) {
                logger.warn(`Failed to copy album cover: ${error.message}`);
            }
        }

        if (assets.length > 0) {
            const maxAsset = assets.reduce((best, asset) => {
                if (!best) return asset;
                if (!best.size) return asset;
                if (!asset.size) return best;
                return asset.size > best.size ? asset : best;
            }, null);

            if (maxAsset && maxAsset.filePath) {
                const coverPath = this.buildAlbumImagePath(albumDir, null);
                if (coverPath && maxAsset.filePath !== coverPath) {
                    try {
                        await ensureDir(path.dirname(coverPath));
                        await fs.copyFile(maxAsset.filePath, coverPath);
                    } catch (error) {
                        logger.warn(`Failed to write album cover: ${error.message}`);
                    }
                }
            }
        }

        return assets.map((asset) => ({ ...asset, albumDir }));
    }

    async ensureArtistImages({ artistId, artistName, pictureId, pictureUrl, sizes = DEFAULT_SIZES, albumDir }) {
        if (!artistId) return [];

        const artistDir = this.resolveArtistDir({ albumDir, artistName });
        if (!artistDir) return [];

        const assets = [];
        const uniqueSizes = Array.from(new Set(sizes.filter((value) => Number.isFinite(value))));

        if (pictureId) {
            for (const size of uniqueSizes) {
                const url = getArtistPictureUrl(pictureId, size);
                const targetPath = this.buildArtistImagePath(artistDir, size);
                const ok = await this.downloadImage(url, targetPath);
                if (ok) {
                    assets.push({ size, url, filePath: targetPath });
                }
            }
        } else if (pictureUrl) {
            const targetPath = this.buildArtistImagePath(artistDir, null);
            const ok = await this.downloadImage(pictureUrl, targetPath);
            if (ok) {
                assets.push({ size: null, url: pictureUrl, filePath: targetPath });
            }
        }

        if (assets.length > 0) {
            const maxAsset = assets.reduce((best, asset) => {
                if (!best) return asset;
                if (!best.size) return asset;
                if (!asset.size) return best;
                return asset.size > best.size ? asset : best;
            }, null);

            if (maxAsset && maxAsset.filePath) {
                const artistPath = this.buildArtistImagePath(artistDir, null);
                if (artistPath && maxAsset.filePath !== artistPath) {
                    try {
                        await ensureDir(path.dirname(artistPath));
                        await fs.copyFile(maxAsset.filePath, artistPath);
                    } catch (error) {
                        logger.warn(`Failed to write artist picture: ${error.message}`);
                    }
                }
            }
        }

        return assets.map((asset) => ({ ...asset, artistDir }));
    }
}
