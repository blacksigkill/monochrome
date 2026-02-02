import express from 'express';
import { PreferencesService } from '../services/preferences-service.js';

const router = express.Router();
const preferencesService = new PreferencesService();

const asyncHandler = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

const ALLOWED_QUALITIES = new Set(['player', 'HI_RES_LOSSLESS', 'LOSSLESS', 'HIGH', 'LOW']);

const normalizeTemplate = (value) => {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
};

const normalizeQuality = (value) => {
    if (!value) return 'player';
    const trimmed = String(value).trim();
    return ALLOWED_QUALITIES.has(trimmed) ? trimmed : null;
};

router.get(
    '/preferences',
    asyncHandler(async (req, res) => {
        const preferences = await preferencesService.getPreferences();
        res.json(preferences);
    })
);

router.put(
    '/preferences',
    asyncHandler(async (req, res) => {
        const { filenameTemplate, downloadQuality } = req.body || {};
        const normalizedTemplate = normalizeTemplate(filenameTemplate);
        const normalizedQuality = normalizeQuality(downloadQuality);

        if (!normalizedTemplate) {
            return res.status(400).json({ error: 'filenameTemplate is required' });
        }

        if (!normalizedQuality) {
            return res.status(400).json({ error: 'downloadQuality is invalid' });
        }

        const updated = await preferencesService.updatePreferences({
            filenameTemplate: normalizedTemplate,
            downloadQuality: normalizedQuality,
        });

        res.json(updated);
    })
);

export default router;
