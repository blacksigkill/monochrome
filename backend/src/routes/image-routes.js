import express from 'express';
import fs from 'fs/promises';
import path from 'path';
import { CacheService } from '../services/cache-service.js';
import { MetadataService } from '../services/metadata-service.js';

const router = express.Router();
const cacheService = new CacheService();
const metadataService = new MetadataService();

const asyncHandler = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

const fileExists = async (filePath) => {
    try {
        await fs.access(filePath);
        return true;
    } catch {
        return false;
    }
};

const getContentType = (filePath) => {
    const ext = path.extname(filePath || '').toLowerCase();
    if (ext === '.png') return 'image/png';
    if (ext === '.webp') return 'image/webp';
    return 'image/jpeg';
};

router.get(
    '/album/:albumId',
    asyncHandler(async (req, res) => {
        const { albumId } = req.params;
        if (!albumId) {
            return res.status(400).json({ error: 'albumId is required' });
        }

        const albumMeta = metadataService.getAlbumMetadata(albumId);
        const coverPath = albumMeta?.coverPath || cacheService.getAlbumCoverPath(albumId);
        if (!coverPath || !(await fileExists(coverPath))) {
            return res.status(404).json({ error: 'Album cover not found' });
        }

        res.setHeader('Content-Type', getContentType(coverPath));
        res.setHeader('Cache-Control', 'no-store');
        return res.sendFile(coverPath);
    })
);

router.get(
    '/artist/:artistId',
    asyncHandler(async (req, res) => {
        const { artistId } = req.params;
        if (!artistId) {
            return res.status(400).json({ error: 'artistId is required' });
        }

        const artistMeta = metadataService.getArtistMetadata(artistId);
        const picturePath = artistMeta?.picturePath;
        if (!picturePath || !(await fileExists(picturePath))) {
            return res.status(404).json({ error: 'Artist picture not found' });
        }

        res.setHeader('Content-Type', getContentType(picturePath));
        res.setHeader('Cache-Control', 'no-store');
        return res.sendFile(picturePath);
    })
);

export default router;
