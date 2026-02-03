import fetch from 'node-fetch';
import { logger } from '../logger.js';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class APIService {
    constructor(apiInstances = []) {
        this.instances = apiInstances;
        this.streamCache = new Map();
    }

    async fetchWithRetry(relativePath, options = {}) {
        const instances = this.instances;

        if (instances.length === 0) {
            throw new Error('No API instances provided');
        }

        const maxTotalAttempts = instances.length * 2;
        let lastError = null;
        let instanceIndex = 0;

        for (let attempt = 1; attempt <= maxTotalAttempts; attempt++) {
            const baseUrl = instances[instanceIndex % instances.length];
            const url = baseUrl.endsWith('/') ? `${baseUrl}${relativePath.substring(1)}` : `${baseUrl}${relativePath}`;

            try {
                const response = await fetch(url, { signal: options.signal });

                if (response.status === 429) {
                    logger.warn(`Rate limit hit on ${baseUrl}. Trying next instance...`);
                    instanceIndex++;
                    await delay(500);
                    continue;
                }

                if (response.ok) {
                    return response;
                }

                if (response.status === 401) {
                    const errorData = await response.clone().json();
                    if (errorData?.subStatus === 11002) {
                        logger.warn(`Auth failed on ${baseUrl}. Trying next instance...`);
                        instanceIndex++;
                        continue;
                    }
                }

                if (response.status >= 500) {
                    logger.warn(`Server error ${response.status} on ${baseUrl}. Trying next instance...`);
                    instanceIndex++;
                    continue;
                }

                lastError = new Error(`Request failed with status ${response.status}`);
                instanceIndex++;
            } catch (error) {
                if (error.name === 'AbortError') throw error;
                lastError = error;
                logger.warn(`Network error on ${baseUrl}: ${error.message}. Trying next instance...`);
                instanceIndex++;
                await delay(200);
            }
        }

        throw lastError || new Error(`All API instances failed for: ${relativePath}`);
    }

    parseTrackLookup(data) {
        const entries = Array.isArray(data) ? data : [data];
        let track, info, originalTrackUrl;

        for (const entry of entries) {
            if (!entry || typeof entry !== 'object') continue;

            if (!track && 'duration' in entry) {
                track = entry;
                continue;
            }

            if (!info && 'manifest' in entry) {
                info = entry;
                continue;
            }

            if (!originalTrackUrl && 'OriginalTrackUrl' in entry) {
                const candidate = entry.OriginalTrackUrl;
                if (typeof candidate === 'string') {
                    originalTrackUrl = candidate;
                }
            }
        }

        if (!track || !info) {
            throw new Error('Malformed track response');
        }

        return { track, info, originalTrackUrl };
    }

    normalizeTrackResponse(apiResponse) {
        if (!apiResponse || typeof apiResponse !== 'object') {
            return apiResponse;
        }

        const raw = apiResponse.data ?? apiResponse;

        const trackStub = {
            duration: raw.duration ?? 0,
            id: raw.trackId ?? null,
        };

        return [trackStub, raw];
    }

    decodeManifest(manifest) {
        if (!manifest || typeof manifest !== 'string') return '';
        try {
            return Buffer.from(manifest, 'base64').toString('utf-8');
        } catch (error) {
            logger.warn(`Failed to decode manifest: ${error.message}`);
            return '';
        }
    }

    isDashManifest(manifestContent) {
        return typeof manifestContent === 'string' && manifestContent.includes('<MPD');
    }

    extractStreamUrlFromDecodedManifest(decoded) {
        if (!decoded) return null;

        try {
            const parsed = JSON.parse(decoded);
            if (parsed?.urls?.[0]) {
                return parsed.urls[0];
            }
            if (typeof parsed === 'string') {
                return parsed;
            }
        } catch {
            const match = decoded.match(/https?:\/\/[\w\-.~:?#[@!$&'()*+,;=%/]+/);
            return match ? match[0] : null;
        }

        return null;
    }

    extractStreamUrlFromManifest(manifest) {
        const decoded = this.decodeManifest(manifest);
        if (!decoded) return null;
        if (this.isDashManifest(decoded)) return null;
        return this.extractStreamUrlFromDecodedManifest(decoded);
    }

    async getTrackMetadata(id) {
        const response = await this.fetchWithRetry(`/info/?id=${id}`);
        const json = await response.json();
        const data = json.data ?? json;

        const items = Array.isArray(data) ? data : [data];
        const found = items.find((item) => item?.id == id || item?.item?.id == id);

        if (found) {
            return found.item || found;
        }

        throw new Error('Track metadata not found');
    }

    async getAlbumMetadata(id) {
        const response = await this.fetchWithRetry(`/album/?id=${id}`);
        return response.json();
    }

    async getArtistMetadata(id) {
        const [primaryResponse, contentResponse] = await Promise.all([
            this.fetchWithRetry(`/artist/?id=${id}`),
            this.fetchWithRetry(`/artist/?f=${id}&skip_tracks=true`),
        ]);

        const primary = await primaryResponse.json();
        const content = await contentResponse.json();

        return { primary, content };
    }

    async getTrack(id, quality = 'HI_RES_LOSSLESS') {
        const response = await this.fetchWithRetry(`/track/?id=${id}&quality=${quality}`, { type: 'streaming' });
        const jsonResponse = await response.json();
        const result = this.parseTrackLookup(this.normalizeTrackResponse(jsonResponse));
        return result;
    }

    async getStreamUrl(id, quality = 'HI_RES_LOSSLESS') {
        const cacheKey = `stream_${id}_${quality}`;

        if (this.streamCache.has(cacheKey)) {
            return this.streamCache.get(cacheKey);
        }

        const lookup = await this.getTrack(id, quality);

        let streamUrl;
        if (lookup.originalTrackUrl) {
            streamUrl = lookup.originalTrackUrl;
        } else {
            streamUrl = this.extractStreamUrlFromManifest(lookup.info.manifest);
            if (!streamUrl) {
                throw new Error('Could not resolve stream URL');
            }
        }

        this.streamCache.set(cacheKey, streamUrl);
        return streamUrl;
    }
}
