export function detectExtension(buffer) {
    if (buffer.length < 12) return 'audio';

    // FLAC signature: fLaC (0x664C6143)
    if (buffer[0] === 0x66 && buffer[1] === 0x4c && buffer[2] === 0x61 && buffer[3] === 0x43) {
        return 'flac';
    }

    // M4A/MP4 signature: ftyp box
    if (buffer[4] === 0x66 && buffer[5] === 0x74 && buffer[6] === 0x79 && buffer[7] === 0x70) {
        return 'm4a';
    }

    // MP3 signature: ID3 tag or MPEG frame sync
    if (
        (buffer[0] === 0x49 && buffer[1] === 0x44 && buffer[2] === 0x33) || // ID3
        (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0)
    ) {
        // MPEG sync
        return 'mp3';
    }

    // OGG signature
    if (buffer[0] === 0x4f && buffer[1] === 0x67 && buffer[2] === 0x67 && buffer[3] === 0x53) {
        return 'ogg';
    }

    // WAV/RIFF signature
    if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46) {
        return 'wav';
    }

    return 'audio';
}

export const DEFAULT_FILENAME_TEMPLATE = '{trackNumber} - {artist} - {title}';

export const sanitizeForFilename = (value) => {
    if (!value) return 'Unknown';
    return value
        .replace(/[\\/:*?"<>|]/g, '_')
        .replace(/\s+/g, ' ')
        .trim();
};

export const getTrackTitle = (track, { fallback = 'Unknown Title' } = {}) => {
    if (!track?.title) return fallback;
    return track?.version ? `${track.title} (${track.version})` : track.title;
};

export const getTrackArtists = (track = {}, { fallback = 'Unknown Artist' } = {}) => {
    if (track?.artists?.length) {
        return track.artists.map((artist) => artist?.name).join(', ');
    }

    if (track?.artist?.name) {
        return track.artist.name;
    }

    return fallback;
};

export const formatTemplate = (template, data) => {
    let result = template;
    result = result.replace(/\{trackNumber\}/g, data.trackNumber ? String(data.trackNumber).padStart(2, '0') : '00');
    result = result.replace(/\{artist\}/g, sanitizeForFilename(data.artist || 'Unknown Artist'));
    result = result.replace(/\{title\}/g, sanitizeForFilename(data.title || 'Unknown Title'));
    result = result.replace(/\{album\}/g, sanitizeForFilename(data.album || 'Unknown Album'));
    result = result.replace(/\{albumArtist\}/g, sanitizeForFilename(data.albumArtist || 'Unknown Artist'));
    result = result.replace(/\{albumTitle\}/g, sanitizeForFilename(data.albumTitle || 'Unknown Album'));
    result = result.replace(/\{year\}/g, data.year || 'Unknown');
    return result;
};

export const buildTrackFilename = (track, template, extension) => {
    const resolvedTemplate = template?.trim() || DEFAULT_FILENAME_TEMPLATE;
    const artistName = track?.artist?.name || track?.artists?.[0]?.name || 'Unknown Artist';
    const albumTitle = track?.album?.title || track?.album?.name;
    const albumArtist = track?.album?.artist?.name || artistName;

    const releaseDate = track?.album?.releaseDate || track?.streamStartDate;
    let year = 'Unknown';
    if (releaseDate) {
        const parsedDate = new Date(releaseDate);
        if (!Number.isNaN(parsedDate.getTime())) {
            year = String(parsedDate.getFullYear());
        }
    }

    const data = {
        trackNumber: track?.trackNumber,
        artist: artistName,
        title: getTrackTitle(track),
        album: albumTitle,
        albumArtist,
        albumTitle,
        year,
    };

    const normalizedExtension = String(extension || 'flac').replace(/^\./, '');
    return `${formatTemplate(resolvedTemplate, data)}.${normalizedExtension}`;
};
