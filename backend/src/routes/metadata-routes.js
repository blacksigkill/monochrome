import express from 'express';
import fs from 'fs/promises';
import { CacheService } from '../services/cache-service.js';
import { ImageService } from '../services/image-service.js';
import { MetadataService } from '../services/metadata-service.js';

const router = express.Router();
const metadataService = new MetadataService();
const cacheService = new CacheService();
const imageService = new ImageService();

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
            const coverAsset = metadataService.getBestImageAsset('album', albumId, 'cover');
            const coverPath =
                coverAsset?.filePath ||
                metadataService.getAlbumMetadata(albumId)?.coverPath ||
                cacheService.getAlbumCoverPath(albumId);
            if (coverPath && (await fileExists(coverPath))) {
                track.album = track.album || {};
                track.album.cover = `/api/images/album/${encodeURIComponent(albumId)}`;
            }
        }

        if (artistId) {
            const pictureAsset = metadataService.getBestImageAsset('artist', artistId, 'picture');
            const picturePath = pictureAsset?.filePath || metadataService.getArtistMetadata(artistId)?.picturePath;
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

        const coverAsset = metadataService.getBestImageAsset('album', albumId, 'cover');
        const coverPath = coverAsset?.filePath || albumMeta.coverPath || cacheService.getAlbumCoverPath(albumId);
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

        const pictureAsset = metadataService.getBestImageAsset('artist', artistId, 'picture');
        const picturePath = pictureAsset?.filePath || artistMeta.picturePath;
        if (picturePath && (await fileExists(picturePath))) {
            const pictureUrl = `/api/images/artist/${encodeURIComponent(artistId)}`;
            injectArtistPictureUrl(artistMeta.payload, pictureUrl);
        }

        res.setHeader('Cache-Control', 'no-store');
        res.json(artistMeta.payload);
    })
);

router.post(
    '/track',
    asyncHandler(async (req, res) => {
        const track = req.body?.track || req.body?.payload || req.body;
        const trackId = track?.id || track?.trackId || null;
        if (!track || !trackId) {
            return res.status(400).json({ error: 'track payload is required' });
        }

        const trackRecord = metadataService.upsertTrackMetadata(trackId, track || {});
        const albumId = track?.album?.id || track?.albumId || track?.album_id || trackRecord?.albumId || null;
        const artistId = track?.artist?.id || track?.artists?.[0]?.id || null;
        const artistName = trackRecord?.albumArtist || trackRecord?.artist || track?.artist?.name || null;
        const albumTitle = trackRecord?.albumTitle || track?.album?.title || track?.album?.name || null;

        let albumDir = imageService.resolveAlbumDir({ trackPath: null, artistName, albumTitle });

        if (albumId) {
            const albumPayload = track?.album ? { album: track.album } : track;
            const albumRecord = metadataService.upsertAlbumMetadata(albumId, albumPayload);
            const albumAssets = await imageService.ensureAlbumImages({
                albumId,
                artistName: albumRecord?.artist || artistName,
                albumTitle: albumRecord?.title || albumTitle,
                coverId: albumRecord?.coverId || track?.album?.cover || track?.album?.coverId || null,
                coverUrl: albumRecord?.coverUrl,
                trackPath: null,
            });

            if (albumAssets.length > 0) {
                albumDir = albumAssets[0].albumDir || albumDir;
                albumAssets.forEach((asset) => {
                    metadataService.upsertImageAsset({
                        ownerType: 'album',
                        ownerId: albumId,
                        kind: 'cover',
                        size: asset.size,
                        url: asset.url,
                        filePath: asset.filePath,
                    });
                });

                const coverPath = imageService.buildAlbumImagePath(albumDir, null);
                if (coverPath) {
                    metadataService.updateAlbumCoverPath(albumId, coverPath);
                }
            }
        }

        if (artistId) {
            const artistPayload = track?.artist ? { artist: track.artist } : track;
            const artistRecord = metadataService.upsertArtistMetadata(artistId, artistPayload);
            const artistAssets = await imageService.ensureArtistImages({
                artistId,
                artistName: artistRecord?.name || artistName,
                pictureId: artistRecord?.pictureId || track?.artist?.picture || null,
                pictureUrl: artistRecord?.pictureUrl,
                albumDir,
            });

            if (artistAssets.length > 0) {
                artistAssets.forEach((asset) => {
                    metadataService.upsertImageAsset({
                        ownerType: 'artist',
                        ownerId: artistId,
                        kind: 'picture',
                        size: asset.size,
                        url: asset.url,
                        filePath: asset.filePath,
                    });
                });

                const artistDir = artistAssets[0].artistDir;
                const picturePath = artistDir ? imageService.buildArtistImagePath(artistDir, null) : null;
                if (picturePath) {
                    metadataService.updateArtistPicturePath(artistId, picturePath);
                }
            }
        }

        res.json({ success: true, trackId });
    })
);

router.post(
    '/album',
    asyncHandler(async (req, res) => {
        const payload = req.body?.payload || req.body;
        if (!payload) {
            return res.status(400).json({ error: 'album payload is required' });
        }

        const albumRecord = metadataService.upsertAlbumMetadata(null, payload);
        if (!albumRecord?.albumId) {
            return res.status(400).json({ error: 'albumId is required' });
        }

        const albumAssets = await imageService.ensureAlbumImages({
            albumId: albumRecord.albumId,
            artistName: albumRecord.artist,
            albumTitle: albumRecord.title,
            coverId: albumRecord.coverId,
            coverUrl: albumRecord.coverUrl,
        });

        if (albumAssets.length > 0) {
            albumAssets.forEach((asset) => {
                metadataService.upsertImageAsset({
                    ownerType: 'album',
                    ownerId: albumRecord.albumId,
                    kind: 'cover',
                    size: asset.size,
                    url: asset.url,
                    filePath: asset.filePath,
                });
            });

            const albumDir = albumAssets[0].albumDir;
            const coverPath = albumDir ? imageService.buildAlbumImagePath(albumDir, null) : null;
            if (coverPath) {
                metadataService.updateAlbumCoverPath(albumRecord.albumId, coverPath);
            }
        }

        res.json({ success: true, albumId: albumRecord.albumId });
    })
);

router.post(
    '/artist',
    asyncHandler(async (req, res) => {
        const payload = req.body?.payload || req.body;
        if (!payload) {
            return res.status(400).json({ error: 'artist payload is required' });
        }

        const artistRecord = metadataService.upsertArtistMetadata(null, payload);
        if (!artistRecord?.artistId) {
            return res.status(400).json({ error: 'artistId is required' });
        }

        const artistAssets = await imageService.ensureArtistImages({
            artistId: artistRecord.artistId,
            artistName: artistRecord.name,
            pictureId: artistRecord.pictureId,
            pictureUrl: artistRecord.pictureUrl,
        });

        if (artistAssets.length > 0) {
            artistAssets.forEach((asset) => {
                metadataService.upsertImageAsset({
                    ownerType: 'artist',
                    ownerId: artistRecord.artistId,
                    kind: 'picture',
                    size: asset.size,
                    url: asset.url,
                    filePath: asset.filePath,
                });
            });

            const artistDir = artistAssets[0].artistDir;
            const picturePath = artistDir ? imageService.buildArtistImagePath(artistDir, null) : null;
            if (picturePath) {
                metadataService.updateArtistPicturePath(artistRecord.artistId, picturePath);
            }
        }

        res.json({ success: true, artistId: artistRecord.artistId });
    })
);

export default router;
