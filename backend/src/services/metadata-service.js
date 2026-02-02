import { db } from '../db/index.js';
import { getCoverUrl, getTrackArtists, getTrackTitle } from '../utils/helpers.js';

const resolveAlbumId = (track) => {
    const album = track?.album || {};
    return album.id || album.albumId || track?.albumId || track?.album_id || null;
};

const resolveAlbumTitle = (track) => {
    const album = track?.album || {};
    return album.title || album.name || track?.albumTitle || track?.album_title || null;
};

const resolveAlbumArtist = (track) => {
    const album = track?.album || {};
    if (album.artist?.name) return album.artist.name;
    if (typeof album.artist === 'string') return album.artist;
    if (Array.isArray(album.artists) && album.artists.length > 0) {
        return album.artists[0]?.name || album.artists[0];
    }
    return null;
};

const resolveCoverId = (track) => {
    const album = track?.album || {};
    return (
        album.cover ||
        album.coverId ||
        album.cover_id ||
        album.image ||
        album.cover?.id ||
        track?.coverId ||
        track?.cover_id ||
        null
    );
};

const resolveYear = (track) => {
    const date =
        track?.album?.releaseDate || track?.album?.release_date || track?.streamStartDate || track?.releaseDate;
    if (!date) return null;
    const parsed = new Date(date);
    if (Number.isNaN(parsed.getTime())) return null;
    return String(parsed.getFullYear());
};

export class MetadataService {
    upsertTrackMetadata(trackId, track) {
        const albumId = resolveAlbumId(track);
        const title = getTrackTitle(track);
        const artist = getTrackArtists(track);
        const albumTitle = resolveAlbumTitle(track) || 'Unknown Album';
        const albumArtist = resolveAlbumArtist(track) || artist || 'Unknown Artist';
        const trackNumber = track?.trackNumber || track?.track_number || null;
        const year = resolveYear(track);
        const coverId = resolveCoverId(track);
        const coverUrl = getCoverUrl(coverId, '1280');
        const now = new Date().toISOString();

        const payload = {
            trackId,
            albumId,
            title,
            artist,
            albumTitle,
            albumArtist,
            trackNumber,
            year,
            coverUrl,
            rawJson: JSON.stringify(track || {}),
            updatedAt: now,
        };

        db.prepare(
            `
                INSERT INTO metadata (
                    track_id,
                    album_id,
                    title,
                    artist,
                    album_title,
                    album_artist,
                    track_number,
                    year,
                    cover_url,
                    raw_json,
                    updated_at
                )
                VALUES (
                    @trackId,
                    @albumId,
                    @title,
                    @artist,
                    @albumTitle,
                    @albumArtist,
                    @trackNumber,
                    @year,
                    @coverUrl,
                    @rawJson,
                    @updatedAt
                )
                ON CONFLICT(track_id) DO UPDATE SET
                    album_id = excluded.album_id,
                    title = excluded.title,
                    artist = excluded.artist,
                    album_title = excluded.album_title,
                    album_artist = excluded.album_artist,
                    track_number = excluded.track_number,
                    year = excluded.year,
                    cover_url = excluded.cover_url,
                    raw_json = excluded.raw_json,
                    updated_at = excluded.updated_at
            `
        ).run(payload);

        return {
            trackId,
            albumId,
            title,
            artist,
            albumTitle,
            albumArtist,
            trackNumber,
            year,
            coverUrl,
        };
    }
}
