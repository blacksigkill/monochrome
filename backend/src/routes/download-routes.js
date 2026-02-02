import express from 'express';
import { DownloadService } from '../services/download-service.js';
import { logger } from '../logger.js';

const router = express.Router();
const downloadService = new DownloadService();
const DEFAULT_QUALITY = 'HI_RES_LOSSLESS';

const asyncHandler = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

const normalizeApiInstances = (instances) => {
    if (!Array.isArray(instances)) return [];
    return instances.map((instance) => (typeof instance === 'string' ? instance.trim() : '')).filter(Boolean);
};

router.post(
    '/trigger',
    asyncHandler(async (req, res) => {
        const { trackId, quality, apiInstances } = req.body;

        if (!trackId) {
            return res.status(400).json({ error: 'trackId is required' });
        }

        const normalizedInstances = normalizeApiInstances(apiInstances);
        if (normalizedInstances.length === 0) {
            return res.status(400).json({ error: 'apiInstances array is required' });
        }

        const qualityToUse = quality || DEFAULT_QUALITY;

        // Launch download in background (non-blocking)
        void downloadService
            .downloadTrack(trackId, qualityToUse, normalizedInstances)
            .then((result) => {
                logger.info(`Download completed for track ${trackId}: ${result.status}`);
            })
            .catch((err) => {
                logger.warn(`Download failed for track ${trackId}: ${err.message}`);
            });

        // Respond immediately
        res.json({ success: true, status: 'queued', trackId });
    })
);

router.get(
    '/status/:trackId',
    asyncHandler(async (req, res) => {
        const { trackId } = req.params;
        const quality = req.query.quality || DEFAULT_QUALITY;

        const status = await downloadService.getStatus(trackId, quality);
        res.json(status);
    })
);

export default router;
