import fs from 'fs/promises';
import path from 'path';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { DEFAULT_FILENAME_TEMPLATE } from '../utils/helpers.js';

const DEFAULT_PREFERENCES = {
    filenameTemplate: DEFAULT_FILENAME_TEMPLATE,
    downloadQuality: 'player',
};

export class PreferencesService {
    constructor({ filePath } = {}) {
        const resolvedStoragePath = path.resolve(config.storagePath);
        this.filePath = filePath || path.join(resolvedStoragePath, '..', 'preferences.json');
    }

    async getPreferences() {
        try {
            const content = await fs.readFile(this.filePath, 'utf-8');
            const stored = JSON.parse(content);
            return { ...DEFAULT_PREFERENCES, ...stored };
        } catch (error) {
            if (error.code !== 'ENOENT') {
                logger.warn(`Failed to read preferences: ${error.message}`);
            }
            return { ...DEFAULT_PREFERENCES };
        }
    }

    async savePreferences(preferences) {
        const next = { ...DEFAULT_PREFERENCES, ...preferences };
        await fs.mkdir(path.dirname(this.filePath), { recursive: true });
        await fs.writeFile(this.filePath, JSON.stringify(next, null, 2));
        return next;
    }

    async updatePreferences(update) {
        const current = await this.getPreferences();
        return this.savePreferences({ ...current, ...update });
    }
}
