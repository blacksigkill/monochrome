import { db } from '../db/index.js';
import { getArtistPictureUrl, getCoverUrl, getTrackArtists, getTrackTitle } from '../utils/helpers.js';

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

const unwrapPayload = (payload) => (payload && typeof payload === 'object' ? (payload.data ?? payload) : payload);

const resolveAlbumFromPayload = (payload) => {
    const raw = unwrapPayload(payload);
    if (!raw || typeof raw !== 'object') return null;

    if (raw.album && typeof raw.album === 'object') return raw.album;

    if (!Array.isArray(raw) && ('title' in raw || 'name' in raw || 'numberOfTracks' in raw || 'id' in raw)) {
        return raw;
    }

    if (Array.isArray(raw)) {
        return (
            raw.find((entry) =>
                entry && typeof entry === 'object'
                    ? 'title' in entry || 'name' in entry || 'numberOfTracks' in entry || 'id' in entry
                    : false
            ) || null
        );
    }

    return null;
};

const resolveAlbumCoverIdFromAlbum = (album) => {
    if (!album || typeof album !== 'object') return null;
    return album.cover || album.coverId || album.cover_id || album.image || album.cover?.id || null;
};

const resolveAlbumArtistFromAlbum = (album) => {
    if (!album || typeof album !== 'object') return null;
    if (album.artist?.name) return album.artist.name;
    if (typeof album.artist === 'string') return album.artist;
    if (Array.isArray(album.artists) && album.artists.length > 0) {
        return album.artists[0]?.name || album.artists[0];
    }
    return null;
};

const resolveArtistFromPayload = (payload) => {
    const raw = payload?.primary ?? payload;
    const data = unwrapPayload(raw);
    if (!data) return null;

    if (data.artist && typeof data.artist === 'object') return data.artist;
    if (Array.isArray(data) && data.length > 0) return data[0];
    return data;
};

const resolveArtistNameFromArtist = (artist) => {
    if (!artist || typeof artist !== 'object') return null;
    return artist.name || artist.title || null;
};

const resolveArtistPictureIdFromArtist = (artist) => {
    if (!artist || typeof artist !== 'object') return null;
    return artist.picture || artist.pictureId || artist.picture_id || artist.image || artist.imageId || null;
};

const resolveArtistBioFromArtist = (artist) => {
    if (!artist || typeof artist !== 'object') return null;
    return (
        artist.bio || artist.biography || artist.description || artist.profile || artist.text || artist.summary || null
    );
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

    upsertAlbumMetadata(albumId, payload, { coverPath } = {}) {
        const album = resolveAlbumFromPayload(payload) || {};
        const resolvedAlbumId = albumId || album.id || album.albumId || album.album_id || null;
        if (!resolvedAlbumId) return null;

        const title = album.title || album.name || 'Unknown Album';
        const artist = resolveAlbumArtistFromAlbum(album) || 'Unknown Artist';
        const coverId = resolveAlbumCoverIdFromAlbum(album);
        const coverUrl = getCoverUrl(coverId, '1280');
        const now = new Date().toISOString();

        db.prepare(
            `
                INSERT INTO album_metadata (
                    album_id,
                    title,
                    artist,
                    cover_url,
                    cover_path,
                    raw_json,
                    updated_at
                )
                VALUES (
                    @albumId,
                    @title,
                    @artist,
                    @coverUrl,
                    @coverPath,
                    @rawJson,
                    @updatedAt
                )
                ON CONFLICT(album_id) DO UPDATE SET
                    title = excluded.title,
                    artist = excluded.artist,
                    cover_url = excluded.cover_url,
                    cover_path = COALESCE(excluded.cover_path, album_metadata.cover_path),
                    raw_json = excluded.raw_json,
                    updated_at = excluded.updated_at
            `
        ).run({
            albumId: resolvedAlbumId,
            title,
            artist,
            coverUrl,
            coverPath: coverPath || null,
            rawJson: JSON.stringify(payload || {}),
            updatedAt: now,
        });

        return {
            albumId: resolvedAlbumId,
            title,
            artist,
            coverUrl,
            coverPath: coverPath || null,
        };
    }

    upsertArtistMetadata(artistId, payload, { picturePath } = {}) {
        const artist = resolveArtistFromPayload(payload) || {};
        const resolvedArtistId = artistId || artist.id || artist.artistId || artist.artist_id || null;
        if (!resolvedArtistId) return null;

        const name = resolveArtistNameFromArtist(artist) || 'Unknown Artist';
        const pictureId = resolveArtistPictureIdFromArtist(artist);
        const pictureUrl = getArtistPictureUrl(pictureId, '1280');
        const bio = resolveArtistBioFromArtist(artist);
        const now = new Date().toISOString();

        db.prepare(
            `
                INSERT INTO artist_metadata (
                    artist_id,
                    name,
                    picture_url,
                    picture_path,
                    bio,
                    raw_json,
                    updated_at
                )
                VALUES (
                    @artistId,
                    @name,
                    @pictureUrl,
                    @picturePath,
                    @bio,
                    @rawJson,
                    @updatedAt
                )
                ON CONFLICT(artist_id) DO UPDATE SET
                    name = excluded.name,
                    picture_url = excluded.picture_url,
                    picture_path = COALESCE(excluded.picture_path, artist_metadata.picture_path),
                    bio = excluded.bio,
                    raw_json = excluded.raw_json,
                    updated_at = excluded.updated_at
            `
        ).run({
            artistId: resolvedArtistId,
            name,
            pictureUrl,
            picturePath: picturePath || null,
            bio,
            rawJson: JSON.stringify(payload || {}),
            updatedAt: now,
        });

        return {
            artistId: resolvedArtistId,
            name,
            pictureUrl,
            picturePath: picturePath || null,
            bio,
        };
    }

    getTrackMetadata(trackId) {
        const row = db.prepare('SELECT raw_json FROM metadata WHERE track_id = ?').get(trackId);
        if (!row?.raw_json) return null;
        try {
            return JSON.parse(row.raw_json);
        } catch {
            return null;
        }
    }

    getAlbumMetadata(albumId) {
        const row = db.prepare('SELECT raw_json, cover_path FROM album_metadata WHERE album_id = ?').get(albumId);
        if (!row?.raw_json) return null;
        try {
            return { payload: JSON.parse(row.raw_json), coverPath: row.cover_path || null };
        } catch {
            return null;
        }
    }

    getArtistMetadata(artistId) {
        const row = db.prepare('SELECT raw_json, picture_path FROM artist_metadata WHERE artist_id = ?').get(artistId);
        if (!row?.raw_json) return null;
        try {
            return { payload: JSON.parse(row.raw_json), picturePath: row.picture_path || null };
        } catch {
            return null;
        }
    }

    updateAlbumCoverPath(albumId, coverPath) {
        if (!albumId || !coverPath) return;
        db.prepare('UPDATE album_metadata SET cover_path = @coverPath WHERE album_id = @albumId').run({
            albumId,
            coverPath,
        });
    }

    updateArtistPicturePath(artistId, picturePath) {
        if (!artistId || !picturePath) return;
        db.prepare('UPDATE artist_metadata SET picture_path = @picturePath WHERE artist_id = @artistId').run({
            artistId,
            picturePath,
        });
    }
}
