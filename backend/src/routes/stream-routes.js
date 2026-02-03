import express from 'express';
import fs from 'fs';
import fsPromises from 'fs/promises';
import path from 'path';
import { DownloadService } from '../services/download-service.js';
import { logger } from '../logger.js';

const router = express.Router();
const downloadService = new DownloadService();
const DEFAULT_QUALITY = 'HI_RES_LOSSLESS';

const asyncHandler = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

const EXTENSION_MIME_MAP = {
    '.flac': 'audio/flac',
    '.m4a': 'audio/mp4',
    '.mp4': 'audio/mp4',
    '.mp3': 'audio/mpeg',
    '.ogg': 'audio/ogg',
    '.wav': 'audio/wav',
    '.aac': 'audio/aac',
};

const getContentType = (filePath) => {
    const ext = path.extname(filePath || '').toLowerCase();
    return EXTENSION_MIME_MAP[ext] || 'application/octet-stream';
};

const parseRangeHeader = (rangeHeader, totalSize) => {
    const match = /bytes=(\d*)-(\d*)/.exec(rangeHeader || '');
    if (!match) return null;

    const startStr = match[1];
    const endStr = match[2];

    if (!startStr && !endStr) return null;

    let start;
    let end;

    if (!startStr) {
        const suffixLength = Number.parseInt(endStr, 10);
        if (Number.isNaN(suffixLength)) return null;
        end = totalSize - 1;
        start = Math.max(totalSize - suffixLength, 0);
    } else {
        start = Number.parseInt(startStr, 10);
        end = endStr ? Number.parseInt(endStr, 10) : totalSize - 1;

        if (Number.isNaN(start) || Number.isNaN(end)) return null;
        if (start >= totalSize) return null;
        end = Math.min(end, totalSize - 1);
    }

    if (start > end) return null;

    return { start, end };
};

const streamFile = async (req, res, filePath) => {
    const stat = await fsPromises.stat(filePath);
    const totalSize = stat.size;
    const contentType = getContentType(filePath);

    res.setHeader('Accept-Ranges', 'bytes');

    const rangeHeader = req.headers.range;
    if (rangeHeader) {
        const range = parseRangeHeader(rangeHeader, totalSize);

        if (!range) {
            res.status(416);
            res.setHeader('Content-Range', `bytes */${totalSize}`);
            return res.end();
        }

        const { start, end } = range;
        res.status(206);
        res.setHeader('Content-Type', contentType);
        res.setHeader('Content-Range', `bytes ${start}-${end}/${totalSize}`);
        res.setHeader('Content-Length', end - start + 1);

        if (req.method === 'HEAD') {
            return res.end();
        }

        const stream = fs.createReadStream(filePath, { start, end });
        stream.on('error', (error) => {
            logger.warn(`Stream error for ${filePath}: ${error.message}`);
            if (!res.headersSent) {
                res.status(500).end();
            } else {
                res.destroy();
            }
        });
        return stream.pipe(res);
    }

    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Length', totalSize);

    if (req.method === 'HEAD') {
        return res.end();
    }

    const stream = fs.createReadStream(filePath);
    stream.on('error', (error) => {
        logger.warn(`Stream error for ${filePath}: ${error.message}`);
        if (!res.headersSent) {
            res.status(500).end();
        } else {
            res.destroy();
        }
    });
    return stream.pipe(res);
};

const resolveCachedFile = async (trackId, quality) => {
    const status = await downloadService.getCachedFile(trackId, quality, { fallback: true });
    if (status?.status === 'cached' && status.path) {
        return status;
    }
    return null;
};

router.get(
    '/status/:trackId',
    asyncHandler(async (req, res) => {
        const { trackId } = req.params;
        if (!trackId) {
            return res.status(400).json({ error: 'trackId is required' });
        }

        const quality = req.query.quality || DEFAULT_QUALITY;
        const status = await downloadService.getCachedFile(trackId, quality, { fallback: true });

        res.setHeader('Cache-Control', 'no-store');

        const resolvedQuality = status.quality || quality;
        const streamPath =
            status.status === 'cached'
                ? `/api/stream/${encodeURIComponent(trackId)}?quality=${encodeURIComponent(resolvedQuality)}`
                : null;

        res.json({
            trackId,
            status: status.status,
            available: status.status === 'cached',
            streamPath,
        });
    })
);

const handleStreamRequest = asyncHandler(async (req, res) => {
    const { trackId } = req.params;
    if (!trackId) {
        return res.status(400).json({ error: 'trackId is required' });
    }

    const quality = req.query.quality || DEFAULT_QUALITY;
    const cached = await resolveCachedFile(trackId, quality);

    if (!cached) {
        return res.status(404).json({ error: 'Track not cached' });
    }

    try {
        return await streamFile(req, res, cached.path);
    } catch (error) {
        if (error.code === 'ENOENT') {
            return res.status(404).json({ error: 'Track not found' });
        }
        throw error;
    }
});

router.get('/:trackId', handleStreamRequest);
router.head('/:trackId', handleStreamRequest);

export default router;
