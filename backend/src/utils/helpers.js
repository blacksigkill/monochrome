export function detectExtension(buffer) {
    if (buffer.length < 12) return 'audio';

    // FLAC signature: fLaC (0x664C6143)
    if (buffer[0] === 0x66 && buffer[1] === 0x4C && buffer[2] === 0x61 && buffer[3] === 0x43) {
        return 'flac';
    }

    // M4A/MP4 signature: ftyp box
    if (buffer[4] === 0x66 && buffer[5] === 0x74 && buffer[6] === 0x79 && buffer[7] === 0x70) {
        return 'm4a';
    }

    // MP3 signature: ID3 tag or MPEG frame sync
    if ((buffer[0] === 0x49 && buffer[1] === 0x44 && buffer[2] === 0x33) || // ID3
        (buffer[0] === 0xFF && (buffer[1] & 0xE0) === 0xE0)) { // MPEG sync
        return 'mp3';
    }

    // OGG signature
    if (buffer[0] === 0x4F && buffer[1] === 0x67 && buffer[2] === 0x67 && buffer[3] === 0x53) {
        return 'ogg';
    }

    // WAV/RIFF signature
    if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46) {
        return 'wav';
    }

    return 'audio';
}
