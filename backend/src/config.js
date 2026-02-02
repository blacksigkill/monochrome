import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config({ path: join(__dirname, '../.env') });

const defaultOrigins = 'http://localhost:5173,http://localhost:3000';

const parseOrigins = (value) =>
    (value || defaultOrigins)
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean);

export const config = {
    port: Number.parseInt(process.env.PORT, 10) || 3001,
    storagePath: process.env.STORAGE_PATH || './storage/tracks',
    allowedOrigins: parseOrigins(process.env.ALLOWED_ORIGINS),
    logLevel: process.env.LOG_LEVEL || 'info',
};
