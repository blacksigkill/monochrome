import express from 'express';
import { PreferencesService } from '../services/preferences-service.js';
import { db } from '../db/index.js';

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

const ALLOWED_TABLES = new Set(['admin_settings', 'files', 'metadata']);

const getTableColumns = (tableName) => {
    const columns = db.prepare(`PRAGMA table_info(${tableName})`).all();
    return columns.map((column) => ({
        name: column.name,
        type: column.type,
        notNull: Boolean(column.notnull),
        isPrimary: Boolean(column.pk),
        defaultValue: column.dflt_value ?? null,
    }));
};

const getPrimaryKey = (columns) => columns.find((column) => column.isPrimary)?.name || null;

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

router.get(
    '/db/tables',
    asyncHandler(async (req, res) => {
        const tables = db
            .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
            .all()
            .map((row) => row.name)
            .filter((name) => ALLOWED_TABLES.has(name));
        res.json({ tables });
    })
);

router.get(
    '/db/table/:name',
    asyncHandler(async (req, res) => {
        const tableName = req.params.name;
        if (!ALLOWED_TABLES.has(tableName)) {
            return res.status(400).json({ error: 'Unsupported table' });
        }

        const limit = Math.min(Number.parseInt(req.query.limit, 10) || 50, 200);
        const offset = Math.max(Number.parseInt(req.query.offset, 10) || 0, 0);

        const columns = getTableColumns(tableName);
        const primaryKey = getPrimaryKey(columns);

        const orderBy = primaryKey ? `${primaryKey} DESC` : 'rowid DESC';
        const rows = db.prepare(`SELECT * FROM ${tableName} ORDER BY ${orderBy} LIMIT ? OFFSET ?`).all(limit, offset);

        res.json({
            table: tableName,
            columns,
            primaryKey,
            limit,
            offset,
            rows,
        });
    })
);

router.put(
    '/db/row',
    asyncHandler(async (req, res) => {
        const { table, key, value, data } = req.body || {};

        if (!table || !ALLOWED_TABLES.has(table)) {
            return res.status(400).json({ error: 'Unsupported table' });
        }

        if (!key || typeof key !== 'string') {
            return res.status(400).json({ error: 'Primary key is required' });
        }

        if (!data || typeof data !== 'object') {
            return res.status(400).json({ error: 'Update data is required' });
        }

        const columns = getTableColumns(table);
        const columnNames = new Set(columns.map((column) => column.name));

        if (!columnNames.has(key)) {
            return res.status(400).json({ error: 'Invalid primary key column' });
        }

        const updates = Object.entries(data).filter(([column]) => columnNames.has(column) && column !== key);
        if (updates.length === 0) {
            return res.status(400).json({ error: 'No valid columns to update' });
        }

        const setClause = updates.map(([column]) => `${column} = ?`).join(', ');
        const values = updates.map(([, columnValue]) => columnValue);
        values.push(value);

        const statement = db.prepare(`UPDATE ${table} SET ${setClause} WHERE ${key} = ?`);
        const result = statement.run(...values);

        if (result.changes === 0) {
            return res.status(404).json({ error: 'Row not found' });
        }

        res.json({ success: true, changes: result.changes });
    })
);

export default router;
