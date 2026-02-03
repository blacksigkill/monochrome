import express from 'express';
import fs from 'fs/promises';
import { CacheService } from '../services/cache-service.js';
import { MetadataService } from '../services/metadata-service.js';

const router = express.Router();
const metadataService = new MetadataService();
const cacheService = new CacheService();

const asyncHandler = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

const fileExists = async (filePath) => {
    try {
        await fs.access(filePath);
        return true;
    } catch {
        return false;
    }
};

const injectAlbumCoverUrl = (payload, coverUrl) => {
    if (!payload || !coverUrl) return;
    const raw = payload?.data ?? payload;

    const applyCover = (target) => {
        if (!target || typeof target !== 'object') return;
        if ('cover' in target || 'image' in target || 'coverId' in target || 'cover_id' in target) {
            target.cover = coverUrl;
            target.coverId = coverUrl;
            target.cover_id = coverUrl;
            target.image = coverUrl;
        }
    };

    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        if (raw.album && typeof raw.album === 'object') {
            applyCover(raw.album);
        }
        applyCover(raw);
        return;
    }

    if (Array.isArray(raw)) {
        raw.forEach((entry) => {
            if (!entry || typeof entry !== 'object') return;
            if (entry.album && typeof entry.album === 'object') {
                applyCover(entry.album);
            }
            applyCover(entry);
        });
    }
};

const injectArtistPictureUrl = (payload, pictureUrl) => {
    if (!payload || !pictureUrl) return;
    const raw = payload?.primary ?? payload;
    const data = raw?.data ?? raw;

    const applyPicture = (target) => {
        if (!target || typeof target !== 'object') return;
        if ('picture' in target || 'image' in target || 'pictureId' in target || 'picture_id' in target) {
            target.picture = pictureUrl;
            target.pictureId = pictureUrl;
            target.picture_id = pictureUrl;
            target.image = pictureUrl;
        }
    };

    if (data && typeof data === 'object' && !Array.isArray(data)) {
        if (data.artist && typeof data.artist === 'object') {
            applyPicture(data.artist);
        }
        applyPicture(data);
        return;
    }

    if (Array.isArray(data) && data.length > 0) {
        data.forEach((entry) => {
            if (!entry || typeof entry !== 'object') return;
            if (entry.artist && typeof entry.artist === 'object') {
                applyPicture(entry.artist);
            }
            applyPicture(entry);
        });
    }
};

router.get(
    '/track/:trackId',
    asyncHandler(async (req, res) => {
        const { trackId } = req.params;
        if (!trackId) {
            return res.status(400).json({ error: 'trackId is required' });
        }

        const track = metadataService.getTrackMetadata(trackId);
        if (!track) {
            return res.status(404).json({ error: 'Track metadata not found' });
        }

        const albumId = track?.album?.id || track?.albumId || track?.album_id || null;
        const artistId = track?.artist?.id || track?.artists?.[0]?.id || null;

        if (albumId) {
            const albumMeta = metadataService.getAlbumMetadata(albumId);
            const coverPath = albumMeta?.coverPath || cacheService.getAlbumCoverPath(albumId);
            if (coverPath && (await fileExists(coverPath))) {
                track.album = track.album || {};
                track.album.cover = `/api/images/album/${encodeURIComponent(albumId)}`;
            }
        }

        if (artistId) {
            const artistMeta = metadataService.getArtistMetadata(artistId);
            const picturePath = artistMeta?.picturePath;
            if (picturePath && (await fileExists(picturePath))) {
                track.artist = track.artist || {};
                track.artist.picture = `/api/images/artist/${encodeURIComponent(artistId)}`;
            }
        }

        res.setHeader('Cache-Control', 'no-store');
        res.json(track);
    })
);

router.get(
    '/album/:albumId',
    asyncHandler(async (req, res) => {
        const { albumId } = req.params;
        if (!albumId) {
            return res.status(400).json({ error: 'albumId is required' });
        }

        const albumMeta = metadataService.getAlbumMetadata(albumId);
        if (!albumMeta?.payload) {
            return res.status(404).json({ error: 'Album metadata not found' });
        }

        const coverPath = albumMeta.coverPath || cacheService.getAlbumCoverPath(albumId);
        if (coverPath && (await fileExists(coverPath))) {
            const coverUrl = `/api/images/album/${encodeURIComponent(albumId)}`;
            injectAlbumCoverUrl(albumMeta.payload, coverUrl);
        }

        res.setHeader('Cache-Control', 'no-store');
        res.json(albumMeta.payload);
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
        if (!artistMeta?.payload) {
            return res.status(404).json({ error: 'Artist metadata not found' });
        }

        const picturePath = artistMeta.picturePath;
        if (picturePath && (await fileExists(picturePath))) {
            const pictureUrl = `/api/images/artist/${encodeURIComponent(artistId)}`;
            injectArtistPictureUrl(artistMeta.payload, pictureUrl);
        }

        res.setHeader('Cache-Control', 'no-store');
        res.json(artistMeta.payload);
    })
);

export default router;
