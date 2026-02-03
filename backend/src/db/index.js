import fs from 'fs';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { config } from '../config.js';
import { logger } from '../logger.js';

const resolvedPath = path.resolve(config.dbPath);

try {
    fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
} catch (error) {
    logger.error(`Failed to create database directory: ${error.message}`);
    throw error;
}

export const db = new DatabaseSync(resolvedPath);

db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
    CREATE TABLE IF NOT EXISTS admin_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        filename_template TEXT NOT NULL,
        download_quality TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS metadata (
        track_id TEXT PRIMARY KEY,
        album_id TEXT,
        title TEXT,
        artist TEXT,
        album_title TEXT,
        album_artist TEXT,
        track_number INTEGER,
        year TEXT,
        cover_url TEXT,
        raw_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_metadata_album_id ON metadata(album_id);

    CREATE TABLE IF NOT EXISTS album_metadata (
        album_id TEXT PRIMARY KEY,
        title TEXT,
        artist TEXT,
        cover_url TEXT,
        cover_path TEXT,
        raw_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_album_metadata_album_id ON album_metadata(album_id);

    CREATE TABLE IF NOT EXISTS artist_metadata (
        artist_id TEXT PRIMARY KEY,
        name TEXT,
        picture_url TEXT,
        picture_path TEXT,
        bio TEXT,
        raw_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_artist_metadata_artist_id ON artist_metadata(artist_id);

    CREATE TABLE IF NOT EXISTS image_assets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        owner_type TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        size INTEGER,
        url TEXT,
        file_path TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(owner_type, owner_id, kind, size)
    );

    CREATE INDEX IF NOT EXISTS idx_image_assets_owner ON image_assets(owner_type, owner_id);
    CREATE INDEX IF NOT EXISTS idx_image_assets_kind ON image_assets(kind);

    CREATE TABLE IF NOT EXISTS files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        track_id TEXT NOT NULL,
        album_id TEXT,
        quality TEXT NOT NULL,
        extension TEXT,
        file_path TEXT NOT NULL,
        cover_path TEXT,
        size_bytes INTEGER,
        downloaded_at TEXT NOT NULL,
        UNIQUE(track_id, quality)
    );

    CREATE INDEX IF NOT EXISTS idx_files_album_id ON files(album_id);
    CREATE INDEX IF NOT EXISTS idx_files_track_id ON files(track_id);
`);
