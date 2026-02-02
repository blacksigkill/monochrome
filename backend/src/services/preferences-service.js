import { db } from '../db/index.js';
import { DEFAULT_FILENAME_TEMPLATE } from '../utils/helpers.js';

const DEFAULT_PREFERENCES = {
    filenameTemplate: DEFAULT_FILENAME_TEMPLATE,
    downloadQuality: 'player',
};

export class PreferencesService {
    async getPreferences() {
        const row = db.prepare('SELECT filename_template, download_quality FROM admin_settings WHERE id = 1').get();

        if (row) {
            return {
                ...DEFAULT_PREFERENCES,
                filenameTemplate: row.filename_template,
                downloadQuality: row.download_quality,
            };
        }

        return { ...DEFAULT_PREFERENCES };
    }

    async savePreferences(preferences) {
        const next = { ...DEFAULT_PREFERENCES, ...preferences };
        const now = new Date().toISOString();

        db.prepare(
            `
                INSERT INTO admin_settings (id, filename_template, download_quality, updated_at)
                VALUES (1, @filenameTemplate, @downloadQuality, @updatedAt)
                ON CONFLICT(id) DO UPDATE SET
                    filename_template = excluded.filename_template,
                    download_quality = excluded.download_quality,
                    updated_at = excluded.updated_at
            `
        ).run({
            filenameTemplate: next.filenameTemplate,
            downloadQuality: next.downloadQuality,
            updatedAt: now,
        });

        return next;
    }

    async updatePreferences(update) {
        const current = await this.getPreferences();
        return this.savePreferences({ ...current, ...update });
    }
}
