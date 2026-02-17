//js/exposed.js

import { db } from './db.js';

const LASTFM_PAGE_SIZE = 200;
const LISTENBRAINZ_PAGE_SIZE = 100;
const MALOJA_PAGE_SIZE = 200;
const MAX_PAGE_REQUESTS = 75;
const AVAILABLE_MONTHS_CACHE_TTL = 5 * 60 * 1000;
const MAX_TRACK_ENRICH_LOOKUPS = 30;
const MAX_ALBUM_ENRICH_LOOKUPS = 20;
const MAX_ARTIST_ENRICH_LOOKUPS = 10;
const TRACK_MATCH_MIN_SCORE = 7;
const ALBUM_MATCH_MIN_SCORE = 6;
const ARTIST_MATCH_MIN_SCORE = 5;
const ENRICHMENT_CACHE_KEY = 'exposed_enrichment_cache_v1';
const ENRICHMENT_CACHE_TTL = 30 * 24 * 60 * 60 * 1000;
const TRACK_LOOKUP_CACHE_MAX = 3500;
const ALBUM_LOOKUP_CACHE_MAX = 2500;
const ARTIST_LOOKUP_CACHE_MAX = 2000;

class ExposedManager {
    constructor() {
        this._api = null;
        this._scrobbler = null;
        this._monthCache = new Map();
        this._trackLookupCache = new Map();
        this._albumLookupCache = new Map();
        this._artistLookupCache = new Map();
        this._availableMonthsCache = {
            signature: null,
            expiresAt: 0,
            months: [],
        };
        this._listenBrainzIdentity = {
            token: null,
            username: null,
        };
        this._enrichmentCacheLoaded = false;
        this._enrichmentCacheLoadPromise = null;
        this._enrichmentCacheSaveTimer = null;
    }

    setScrobbler(scrobbler) {
        this._scrobbler = scrobbler;
        this.invalidateCache();
    }

    setApi(api) {
        this._api = api;
        this.invalidateCache();
    }

    invalidateCache() {
        this._monthCache.clear();
        this._trackLookupCache.clear();
        this._albumLookupCache.clear();
        this._artistLookupCache.clear();
        this._availableMonthsCache = {
            signature: null,
            expiresAt: 0,
            months: [],
        };
        this._listenBrainzIdentity = {
            token: null,
            username: null,
        };
        this._enrichmentCacheLoaded = false;
        this._enrichmentCacheLoadPromise = null;
        if (this._enrichmentCacheSaveTimer) {
            clearTimeout(this._enrichmentCacheSaveTimer);
            this._enrichmentCacheSaveTimer = null;
        }
    }

    hasConnectedSources() {
        return this._getConnectedSources().length > 0;
    }

    getConnectedSourceLabels() {
        return this._getConnectedSources().map((source) => source.label);
    }

    async computeMonthlyStats(year, month) {
        const listens = await this._getMonthlyListens(year, month);

        if (listens.length === 0) {
            return null;
        }

        const trackCounts = {};
        const artistCounts = {};
        const albumCounts = {};
        const dailyActivity = {};
        let totalDuration = 0;

        for (const listen of listens) {
            const trackKey = this._getTrackKey(listen);
            if (!trackCounts[trackKey]) {
                trackCounts[trackKey] = {
                    id: listen.trackId,
                    title: listen.title,
                    artistName: listen.artistName,
                    artistId: listen.artistId,
                    albumTitle: listen.albumTitle,
                    albumId: listen.albumId,
                    albumCover: listen.albumCover,
                    count: 0,
                };
            }
            trackCounts[trackKey].count++;

            if (listen.artistName) {
                const normalizedArtistId = this._normalizeArtistId(listen.artistId);
                const artistKey = normalizedArtistId || this._sanitizeKey(listen.artistName);
                if (!artistCounts[artistKey]) {
                    artistCounts[artistKey] = {
                        id: normalizedArtistId,
                        name: listen.artistName,
                        picture: listen.artistPicture || null,
                        count: 0,
                    };
                } else if (!artistCounts[artistKey].picture && listen.artistPicture) {
                    artistCounts[artistKey].picture = listen.artistPicture;
                }
                artistCounts[artistKey].count++;
            }

            if (listen.albumTitle) {
                const albumKey =
                    listen.albumId ||
                    `${this._sanitizeKey(listen.albumTitle)}|${this._sanitizeKey(listen.artistName || 'unknown')}`;
                if (!albumCounts[albumKey]) {
                    albumCounts[albumKey] = {
                        id: this._normalizeAlbumId(listen.albumId),
                        title: listen.albumTitle,
                        artistName: listen.artistName,
                        cover: listen.albumCover,
                        count: 0,
                    };
                }
                albumCounts[albumKey].count++;
            }

            const day = new Date(listen.timestamp).getDate();
            dailyActivity[day] = (dailyActivity[day] || 0) + 1;

            totalDuration += listen.duration || 0;
        }

        const topTracks = Object.values(trackCounts)
            .sort((a, b) => b.count - a.count)
            .slice(0, 10);
        const topArtists = Object.values(artistCounts)
            .sort((a, b) => b.count - a.count)
            .slice(0, 10);
        const topAlbums = Object.values(albumCounts)
            .sort((a, b) => b.count - a.count)
            .slice(0, 10);

        await this._ensureEnrichmentCacheLoaded();
        await this._enrichTopTracks(topTracks);
        this._backfillTopAlbumCovers(topAlbums, topTracks);
        await this._enrichTopAlbums(topAlbums);
        await this._enrichTopArtists(topArtists, topTracks);

        const uniqueArtists = Object.keys(artistCounts).length;

        let peakDay = 0;
        let peakCount = 0;
        for (const [day, count] of Object.entries(dailyActivity)) {
            if (count > peakCount) {
                peakCount = count;
                peakDay = parseInt(day, 10);
            }
        }

        const daysInMonth = new Date(year, month, 0).getDate();
        const dailyArray = [];
        for (let d = 1; d <= daysInMonth; d++) {
            dailyArray.push({ day: d, count: dailyActivity[d] || 0 });
        }

        return {
            totalListens: listens.length,
            totalDuration,
            uniqueArtists,
            peakDay,
            peakDayCount: peakCount,
            topTracks,
            topArtists,
            topAlbums,
            dailyActivity: dailyArray,
        };
    }

    async getAvailableMonths() {
        const sources = this._getConnectedSources();
        if (sources.length === 0) {
            return [];
        }

        const signature = this._getSourcesSignature(sources);
        const now = Date.now();
        if (this._availableMonthsCache.signature === signature && this._availableMonthsCache.expiresAt > now) {
            return this._availableMonthsCache.months;
        }

        const listens = await this._fetchSourcesRange(sources, 0, Math.floor(now / 1000), {
            maxPages: MAX_PAGE_REQUESTS,
        });

        const months = new Set();
        for (const listen of listens) {
            const date = new Date(listen.timestamp);
            months.add(`${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`);
        }

        const sortedMonths = Array.from(months).sort();
        this._availableMonthsCache = {
            signature,
            expiresAt: now + AVAILABLE_MONTHS_CACHE_TTL,
            months: sortedMonths,
        };

        return sortedMonths;
    }

    async _getMonthlyListens(year, month) {
        const sources = this._getConnectedSources();
        if (sources.length === 0) {
            return [];
        }

        const signature = this._getSourcesSignature(sources);
        const monthKey = `${year}-${String(month).padStart(2, '0')}`;
        const cacheKey = `${signature}:${monthKey}`;
        if (this._monthCache.has(cacheKey)) {
            return this._monthCache.get(cacheKey);
        }

        const monthStart = new Date(year, month - 1, 1).getTime();
        const monthEnd = new Date(year, month, 1).getTime();
        const startSec = Math.floor(monthStart / 1000);
        const endSec = Math.floor((monthEnd - 1) / 1000);

        const listens = await this._fetchSourcesRange(sources, startSec, endSec, {
            maxPages: MAX_PAGE_REQUESTS,
        });

        const monthlyListens = listens.filter(
            (listen) => listen.timestamp >= monthStart && listen.timestamp < monthEnd
        );
        this._monthCache.set(cacheKey, monthlyListens);
        return monthlyListens;
    }

    async _fetchSourcesRange(sources, startSec, endSec, options = {}) {
        const settled = await Promise.allSettled(sources.map((source) => source.fetchRange(startSec, endSec, options)));

        const listens = [];
        settled.forEach((result, index) => {
            if (result.status === 'fulfilled') {
                listens.push(...result.value);
            } else {
                console.warn(`[Exposed] Failed to fetch ${sources[index].label} listens:`, result.reason);
            }
        });

        return this._dedupeListens(listens);
    }

    _dedupeListens(listens) {
        const deduped = new Map();
        for (const entry of listens) {
            const normalized = this._normalizeListen(entry);
            if (!normalized) continue;

            const key = `${Math.floor(normalized.timestamp / 1000)}|${this._sanitizeKey(normalized.title)}|${this._sanitizeKey(normalized.artistName)}|${this._sanitizeKey(normalized.albumTitle)}`;
            const existing = deduped.get(key);
            if (!existing) {
                deduped.set(key, normalized);
                continue;
            }

            deduped.set(key, {
                ...existing,
                trackId: existing.trackId || normalized.trackId,
                artistId: existing.artistId || normalized.artistId,
                artistPicture: existing.artistPicture || normalized.artistPicture,
                albumId: existing.albumId || normalized.albumId,
                albumCover: existing.albumCover || normalized.albumCover,
                duration: existing.duration || normalized.duration,
            });
        }

        return Array.from(deduped.values()).sort((a, b) => a.timestamp - b.timestamp);
    }

    _normalizeListen(listen) {
        if (!listen) return null;

        const timestamp = Number(listen.timestamp);
        if (!Number.isFinite(timestamp) || timestamp <= 0) return null;

        return {
            timestamp,
            trackId: this._normalizeTrackId(listen.trackId),
            title: (listen.title || '').toString().trim() || 'Unknown Track',
            duration: this._safeDuration(listen.duration),
            artistName: (listen.artistName || '').toString().trim() || 'Unknown Artist',
            artistId: this._normalizeArtistId(listen.artistId),
            artistPicture: this._nullable(listen.artistPicture),
            albumTitle: (listen.albumTitle || '').toString().trim(),
            albumId: this._normalizeAlbumId(listen.albumId),
            albumCover: this._nullable(listen.albumCover),
        };
    }

    async _ensureEnrichmentCacheLoaded() {
        if (this._enrichmentCacheLoaded) return;

        if (this._enrichmentCacheLoadPromise) {
            await this._enrichmentCacheLoadPromise;
            return;
        }

        this._enrichmentCacheLoadPromise = this._loadEnrichmentCache();
        try {
            await this._enrichmentCacheLoadPromise;
        } finally {
            this._enrichmentCacheLoaded = true;
            this._enrichmentCacheLoadPromise = null;
        }
    }

    async _loadEnrichmentCache() {
        try {
            const payload = await db.getSetting(ENRICHMENT_CACHE_KEY);
            if (!payload || typeof payload !== 'object') return;

            const updatedAt = Number(payload.updatedAt || 0);
            if (!updatedAt || Date.now() - updatedAt > ENRICHMENT_CACHE_TTL) {
                return;
            }

            this._restoreLookupMap(this._trackLookupCache, payload.track, TRACK_LOOKUP_CACHE_MAX);
            this._restoreLookupMap(this._albumLookupCache, payload.album, ALBUM_LOOKUP_CACHE_MAX);
            this._restoreLookupMap(this._artistLookupCache, payload.artist, ARTIST_LOOKUP_CACHE_MAX);
        } catch (error) {
            console.warn('[Exposed] Failed to load enrichment cache:', error);
        }
    }

    _queueEnrichmentCacheSave() {
        if (this._enrichmentCacheSaveTimer) {
            clearTimeout(this._enrichmentCacheSaveTimer);
        }

        this._enrichmentCacheSaveTimer = setTimeout(() => {
            this._enrichmentCacheSaveTimer = null;
            this._persistEnrichmentCache();
        }, 1200);
    }

    async _persistEnrichmentCache() {
        if (!this._enrichmentCacheLoaded) return;

        const payload = {
            updatedAt: Date.now(),
            track: this._serializeLookupMap(this._trackLookupCache, TRACK_LOOKUP_CACHE_MAX),
            album: this._serializeLookupMap(this._albumLookupCache, ALBUM_LOOKUP_CACHE_MAX),
            artist: this._serializeLookupMap(this._artistLookupCache, ARTIST_LOOKUP_CACHE_MAX),
        };

        try {
            await db.saveSetting(ENRICHMENT_CACHE_KEY, payload);
        } catch (error) {
            console.warn('[Exposed] Failed to persist enrichment cache:', error);
        }
    }

    _serializeLookupMap(map, maxEntries) {
        const entries = Array.from(map.entries());
        if (entries.length <= maxEntries) return entries;
        return entries.slice(entries.length - maxEntries);
    }

    _restoreLookupMap(target, entries, maxEntries) {
        if (!Array.isArray(entries)) return;

        for (const entry of entries) {
            if (!Array.isArray(entry) || entry.length !== 2) continue;
            const [key, value] = entry;
            if (typeof key !== 'string' || !key) continue;
            target.set(key, value ?? null);
        }

        this._trimLookupCache(target, maxEntries);
    }

    _getLookupCacheEntry(map, key) {
        if (!map.has(key)) return undefined;

        const value = map.get(key);
        map.delete(key);
        map.set(key, value);
        return value;
    }

    _setLookupCacheEntry(map, key, value, maxEntries) {
        if (typeof key !== 'string' || !key) return;

        if (map.has(key)) {
            map.delete(key);
        }
        map.set(key, value ?? null);
        this._trimLookupCache(map, maxEntries);
        this._queueEnrichmentCacheSave();
    }

    _trimLookupCache(map, maxEntries) {
        while (map.size > maxEntries) {
            const oldestKey = map.keys().next().value;
            map.delete(oldestKey);
        }
    }

    async _enrichTopTracks(topTracks) {
        if (!this._api || !Array.isArray(topTracks) || topTracks.length === 0) return;

        const targets = topTracks.slice(0, MAX_TRACK_ENRICH_LOOKUPS);
        for (const trackEntry of targets) {
            await this._enrichTrackEntry(trackEntry);
        }
    }

    async _enrichTopAlbums(topAlbums) {
        if (!this._api || !Array.isArray(topAlbums) || topAlbums.length === 0) return;

        const targets = topAlbums.filter((album) => !album?.id || !album?.cover).slice(0, MAX_ALBUM_ENRICH_LOOKUPS);
        for (const albumEntry of targets) {
            await this._enrichAlbumEntry(albumEntry);
        }
    }

    async _enrichTopArtists(topArtists, topTracks) {
        if (!this._api || !Array.isArray(topArtists) || topArtists.length === 0) return;

        this._backfillTopArtistsFromTracks(topArtists, topTracks);

        const targets = topArtists
            .filter((artist) => !artist.id || !artist.picture)
            .slice(0, MAX_ARTIST_ENRICH_LOOKUPS);
        for (const artistEntry of targets) {
            await this._enrichArtistEntry(artistEntry);
        }
    }

    _backfillTopArtistsFromTracks(topArtists, topTracks) {
        if (!Array.isArray(topArtists) || !Array.isArray(topTracks)) return;

        const fromTracks = new Map();
        for (const track of topTracks) {
            if (!track) continue;

            const candidates = this._extractArtistNameCandidates(track.artistName);
            if (candidates.length === 0) continue;

            const metadata = {
                id: this._normalizeArtistId(track.artistId),
                picture: track.artistPicture || null,
            };

            if (!metadata.id && !metadata.picture) continue;

            for (const candidateName of candidates) {
                const key = this._normalizeMatchText(candidateName);
                if (!key || fromTracks.has(key)) continue;
                fromTracks.set(key, metadata);
            }
        }

        for (const artist of topArtists) {
            const key = this._normalizeMatchText(artist?.name);
            if (!key || !fromTracks.has(key)) continue;

            const metadata = fromTracks.get(key);
            if (!artist.id && metadata.id) {
                artist.id = metadata.id;
            }
            if (!artist.picture && metadata.picture) {
                artist.picture = metadata.picture;
            }
        }
    }

    async _enrichAlbumEntry(albumEntry) {
        if (!albumEntry?.title) return;
        if (albumEntry.id && albumEntry.cover) return;

        const cacheKey = this._createAlbumLookupCacheKey(albumEntry);
        const cached = this._getLookupCacheEntry(this._albumLookupCache, cacheKey);
        if (cached !== undefined) {
            if (cached) {
                this._applyResolvedAlbumMetadata(albumEntry, cached);
            }
            return;
        }

        const resolved = await this._lookupAlbumMetadata(albumEntry);
        this._setLookupCacheEntry(this._albumLookupCache, cacheKey, resolved || null, ALBUM_LOOKUP_CACHE_MAX);
        if (resolved) {
            this._applyResolvedAlbumMetadata(albumEntry, resolved);
        }
    }

    _applyResolvedAlbumMetadata(albumEntry, resolved) {
        if (!albumEntry || !resolved) return;

        if (!albumEntry.id && resolved.albumId) {
            albumEntry.id = this._normalizeAlbumId(resolved.albumId);
        }
        if (!albumEntry.cover && resolved.cover) {
            albumEntry.cover = resolved.cover;
        }
    }

    async _lookupAlbumMetadata(albumEntry) {
        const query = `${albumEntry.title} ${albumEntry.artistName || ''}`.trim();
        const providers = this._trackLookupProviders();

        for (const provider of providers) {
            try {
                const response = await this._api.searchAlbums(query, { provider, limit: 10 });
                const candidates = Array.isArray(response?.items) ? response.items : [];
                const bestMatch = this._selectBestAlbumCandidate(albumEntry, candidates);

                if (bestMatch) {
                    return {
                        albumId: bestMatch.id || null,
                        cover: bestMatch.cover || null,
                    };
                }
            } catch (error) {
                console.warn(`[Exposed] Album lookup failed on ${provider}:`, error);
            }
        }

        return null;
    }

    _selectBestAlbumCandidate(albumEntry, candidates) {
        let bestCandidate = null;
        let bestScore = -Infinity;

        for (const candidate of candidates) {
            const score = this._scoreAlbumCandidate(albumEntry, candidate);
            if (score > bestScore) {
                bestScore = score;
                bestCandidate = candidate;
            }
        }

        if (bestScore < ALBUM_MATCH_MIN_SCORE) {
            return null;
        }

        return bestCandidate;
    }

    _scoreAlbumCandidate(albumEntry, candidate) {
        if (!candidate) return -Infinity;

        const expectedTitle = this._normalizeMatchText(albumEntry.title);
        const expectedArtist = this._normalizeMatchText(albumEntry.artistName || '');

        const candidateTitle = this._normalizeMatchText(candidate.title || '');
        const candidateArtist = this._normalizeMatchText(candidate.artist?.name || candidate.artists?.[0]?.name || '');

        let score = 0;
        if (expectedTitle && candidateTitle) {
            if (expectedTitle === candidateTitle) score += 6;
            else if (candidateTitle.includes(expectedTitle) || expectedTitle.includes(candidateTitle)) score += 3;
        }

        if (expectedArtist && candidateArtist) {
            if (expectedArtist === candidateArtist) score += 4;
            else if (candidateArtist.includes(expectedArtist) || expectedArtist.includes(candidateArtist)) score += 2;
        }

        if (candidate.cover) {
            score += 1;
        }

        return score;
    }

    _createAlbumLookupCacheKey(albumEntry) {
        const providers = this._trackLookupProviders().join(',');
        const title = this._normalizeMatchText(albumEntry.title || '');
        const artist = this._normalizeMatchText(albumEntry.artistName || '');
        return `${providers}|${title}|${artist}`;
    }

    async _enrichArtistEntry(artistEntry) {
        if (!artistEntry?.name) return;

        if (artistEntry.id && artistEntry.picture) {
            return;
        }

        const cacheKey = this._createArtistLookupCacheKey(artistEntry.name);
        const cached = this._getLookupCacheEntry(this._artistLookupCache, cacheKey);
        if (cached !== undefined) {
            if (cached) {
                this._applyResolvedArtistMetadata(artistEntry, cached);
            }
            return;
        }

        const resolved = await this._lookupArtistMetadata(artistEntry.name);
        this._setLookupCacheEntry(this._artistLookupCache, cacheKey, resolved || null, ARTIST_LOOKUP_CACHE_MAX);
        if (resolved) {
            this._applyResolvedArtistMetadata(artistEntry, resolved);
        }
    }

    _applyResolvedArtistMetadata(artistEntry, resolved) {
        if (!artistEntry || !resolved) return;

        if (!artistEntry.id && resolved.artistId) {
            artistEntry.id = this._normalizeArtistId(resolved.artistId);
        }
        if (!artistEntry.picture && resolved.artistPicture) {
            artistEntry.picture = resolved.artistPicture;
        }
    }

    async _lookupArtistMetadata(artistName) {
        const providers = this._trackLookupProviders();

        for (const provider of providers) {
            try {
                const response = await this._api.searchArtists(artistName, { provider, limit: 8 });
                const candidates = Array.isArray(response?.items) ? response.items : [];
                const bestMatch = this._selectBestArtistCandidate(artistName, candidates);

                if (bestMatch) {
                    return {
                        artistId: bestMatch.id || null,
                        artistPicture: bestMatch.picture || bestMatch.image || null,
                    };
                }
            } catch (error) {
                console.warn(`[Exposed] Artist lookup failed on ${provider}:`, error);
            }
        }

        return null;
    }

    _selectBestArtistCandidate(artistName, candidates) {
        let bestCandidate = null;
        let bestScore = -Infinity;

        for (const candidate of candidates) {
            const score = this._scoreArtistCandidate(artistName, candidate);
            if (score > bestScore) {
                bestScore = score;
                bestCandidate = candidate;
            }
        }

        if (bestScore < ARTIST_MATCH_MIN_SCORE) {
            return null;
        }

        return bestCandidate;
    }

    _scoreArtistCandidate(artistName, candidate) {
        if (!candidate) return -Infinity;

        const expected = this._normalizeMatchText(artistName);
        const candidateName = this._normalizeMatchText(candidate.name || '');
        if (!expected || !candidateName) return -Infinity;

        let score = 0;
        if (expected === candidateName) score += 6;
        else if (candidateName.includes(expected) || expected.includes(candidateName)) score += 3;

        if (candidate.picture || candidate.image) {
            score += 1;
        }

        return score;
    }

    _createArtistLookupCacheKey(artistName) {
        const providers = this._trackLookupProviders().join(',');
        const name = this._normalizeMatchText(artistName);
        return `${providers}|${name}`;
    }

    _extractArtistNameCandidates(artistName) {
        if (!artistName) return [];

        const raw = artistName.toString();
        const seen = new Set();
        const result = [];

        const add = (value) => {
            const normalized = this._normalizeMatchText(value);
            if (!normalized || seen.has(normalized)) return;
            seen.add(normalized);
            result.push(value.toString().trim());
        };

        add(raw);

        const splitRegex = /,|\s+&\s+|\s+x\s+|\s+feat\.?\s+|\s+featuring\s+|\s+ft\.?\s+/i;
        raw.split(splitRegex).forEach((part) => add(part));

        return result;
    }

    async _enrichTrackEntry(trackEntry) {
        if (!trackEntry || !trackEntry.title || !trackEntry.artistName) return;

        if (this._normalizeTrackId(trackEntry.id) && trackEntry.albumCover) {
            return;
        }

        const cacheKey = this._createTrackLookupCacheKey(trackEntry);
        const cached = this._getLookupCacheEntry(this._trackLookupCache, cacheKey);
        if (cached !== undefined) {
            if (cached) {
                this._applyResolvedTrackMetadata(trackEntry, cached);
            }
            return;
        }

        const resolved = await this._lookupTrackMetadata(trackEntry);
        this._setLookupCacheEntry(this._trackLookupCache, cacheKey, resolved || null, TRACK_LOOKUP_CACHE_MAX);
        if (resolved) {
            this._applyResolvedTrackMetadata(trackEntry, resolved);
        }
    }

    _applyResolvedTrackMetadata(trackEntry, resolved) {
        trackEntry.id = this._normalizeTrackId(resolved.trackId) || trackEntry.id || null;
        if (!trackEntry.albumCover && resolved.albumCover) {
            trackEntry.albumCover = resolved.albumCover;
        }
        if (!trackEntry.albumId && resolved.albumId) {
            trackEntry.albumId = this._normalizeAlbumId(resolved.albumId);
        }
        if (!trackEntry.albumTitle && resolved.albumTitle) {
            trackEntry.albumTitle = resolved.albumTitle;
        }
        if (!trackEntry.artistId && resolved.artistId) {
            trackEntry.artistId = this._normalizeArtistId(resolved.artistId);
        }
        if (!trackEntry.artistPicture && resolved.artistPicture) {
            trackEntry.artistPicture = resolved.artistPicture;
        }
        if (!trackEntry.duration && resolved.duration) {
            trackEntry.duration = this._safeDuration(resolved.duration);
        }
    }

    async _lookupTrackMetadata(trackEntry) {
        const query = `${trackEntry.title} ${trackEntry.artistName}`.trim();
        const providers = this._trackLookupProviders();

        for (const provider of providers) {
            try {
                const response = await this._api.searchTracks(query, { provider, limit: 12 });
                const candidates = Array.isArray(response?.items) ? response.items : [];
                const bestMatch = this._selectBestTrackCandidate(trackEntry, candidates);

                if (bestMatch) {
                    const mainArtist = bestMatch.artist || bestMatch.artists?.[0] || null;
                    return {
                        trackId: bestMatch.id || null,
                        albumCover: bestMatch.album?.cover || null,
                        albumId: bestMatch.album?.id || null,
                        albumTitle: bestMatch.album?.title || null,
                        artistId: mainArtist?.id || null,
                        artistPicture: mainArtist?.picture || null,
                        duration: bestMatch.duration || 0,
                    };
                }
            } catch (error) {
                console.warn(`[Exposed] Track lookup failed on ${provider}:`, error);
            }
        }

        return null;
    }

    _selectBestTrackCandidate(trackEntry, candidates) {
        let bestCandidate = null;
        let bestScore = -Infinity;

        for (const candidate of candidates) {
            const score = this._scoreTrackCandidate(trackEntry, candidate);
            if (score > bestScore) {
                bestScore = score;
                bestCandidate = candidate;
            }
        }

        if (bestScore < TRACK_MATCH_MIN_SCORE) {
            return null;
        }

        return bestCandidate;
    }

    _scoreTrackCandidate(trackEntry, candidate) {
        if (!candidate) return -Infinity;

        const entryTitle = this._normalizeMatchText(trackEntry.title);
        const entryArtist = this._normalizeMatchText(trackEntry.artistName);
        const entryAlbum = this._normalizeMatchText(trackEntry.albumTitle);

        const candidateTitle = this._normalizeMatchText(candidate.cleanTitle || candidate.title || '');
        const candidateArtist = this._normalizeMatchText(candidate.artist?.name || candidate.artists?.[0]?.name || '');
        const candidateAlbum = this._normalizeMatchText(candidate.album?.title || '');

        let score = 0;

        if (candidateTitle && entryTitle) {
            if (candidateTitle === entryTitle) score += 6;
            else if (candidateTitle.includes(entryTitle) || entryTitle.includes(candidateTitle)) score += 3;
        }

        if (candidateArtist && entryArtist) {
            if (candidateArtist === entryArtist) score += 6;
            else if (candidateArtist.includes(entryArtist) || entryArtist.includes(candidateArtist)) score += 3;
        }

        if (candidateAlbum && entryAlbum) {
            if (candidateAlbum === entryAlbum) score += 2;
            else if (candidateAlbum.includes(entryAlbum) || entryAlbum.includes(candidateAlbum)) score += 1;
        }

        const candidateDuration = this._safeDuration(candidate.duration);
        const entryDuration = this._safeDuration(trackEntry.duration);
        if (candidateDuration > 0 && entryDuration > 0) {
            const delta = Math.abs(candidateDuration - entryDuration);
            if (delta <= 3) score += 2;
            else if (delta <= 10) score += 1;
        }

        if (candidate.isUnavailable) {
            score -= 1;
        }

        return score;
    }

    _createTrackLookupCacheKey(trackEntry) {
        const providers = this._trackLookupProviders().join(',');
        const title = this._normalizeMatchText(trackEntry.title);
        const artist = this._normalizeMatchText(trackEntry.artistName);
        return `${providers}|${title}|${artist}`;
    }

    _trackLookupProviders() {
        const currentProvider =
            this._api && typeof this._api.getCurrentProvider === 'function' ? this._api.getCurrentProvider() : null;

        if (currentProvider === 'qobuz') {
            return ['qobuz', 'tidal'];
        }

        if (currentProvider === 'tidal') {
            return ['tidal', 'qobuz'];
        }

        return ['tidal', 'qobuz'];
    }

    _normalizeMatchText(value) {
        return (value || '')
            .toString()
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .toLowerCase()
            .replace(/\(.*?\)|\[.*?\]/g, ' ')
            .replace(/\s+(feat|featuring|ft)\.?\s+.+$/i, ' ')
            .replace(/[^a-z0-9]+/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    _normalizeTrackId(value) {
        return this._normalizeCatalogId(value, true);
    }

    _normalizeArtistId(value) {
        return this._normalizeCatalogId(value, false);
    }

    _normalizeAlbumId(value) {
        return this._normalizeCatalogId(value, false);
    }

    _normalizeCatalogId(value, allowTrackerPrefix = false) {
        if (typeof value === 'number' && Number.isFinite(value)) {
            return value;
        }

        if (typeof value !== 'string') {
            return null;
        }

        const normalized = value.trim();
        if (!normalized) {
            return null;
        }

        if (
            /^\d+$/.test(normalized) ||
            normalized.startsWith('q:') ||
            normalized.startsWith('t:') ||
            (allowTrackerPrefix && normalized.startsWith('tracker-'))
        ) {
            return normalized;
        }

        return null;
    }

    _backfillTopAlbumCovers(topAlbums, topTracks) {
        if (!Array.isArray(topAlbums) || !Array.isArray(topTracks)) return;

        const albumFromTracks = new Map();
        for (const track of topTracks) {
            const albumTitle = this._sanitizeKey(track.albumTitle);
            if (!albumTitle) continue;

            const key = `${albumTitle}|${this._sanitizeKey(track.artistName || '')}`;
            if (!albumFromTracks.has(key)) {
                albumFromTracks.set(key, {
                    cover: track.albumCover || null,
                    id: this._normalizeAlbumId(track.albumId),
                });
            }
        }

        for (const album of topAlbums) {
            const key = `${this._sanitizeKey(album.title)}|${this._sanitizeKey(album.artistName || '')}`;
            const resolved = albumFromTracks.get(key);
            if (!resolved) continue;

            if (!album.cover && resolved.cover) {
                album.cover = resolved.cover;
            }
            if (!album.id && resolved.id) {
                album.id = this._normalizeAlbumId(resolved.id);
            }
        }
    }

    _getTrackKey(listen) {
        if (listen.trackId) {
            return `id:${listen.trackId}`;
        }
        return `meta:${this._sanitizeKey(listen.title)}|${this._sanitizeKey(listen.artistName)}|${this._sanitizeKey(listen.albumTitle)}`;
    }

    _sanitizeKey(value) {
        return (value || '').toString().trim().toLowerCase().replace(/\s+/g, ' ');
    }

    _nullable(value) {
        if (value === null || value === undefined || value === '') return null;
        return value;
    }

    _safeDuration(value) {
        const parsed = Number(value);
        if (!Number.isFinite(parsed) || parsed <= 0) return 0;
        return Math.floor(parsed);
    }

    _getSourcesSignature(sources) {
        return sources
            .map((source) => `${source.id}:${source.signature}`)
            .sort()
            .join('|');
    }

    _getConnectedSources() {
        if (!this._scrobbler) return [];

        const sources = [];

        const { lastfm, librefm, listenbrainz, maloja } = this._scrobbler;

        if (lastfm?.isAuthenticated() && lastfm.username) {
            sources.push({
                id: 'lastfm',
                label: 'Last.fm',
                signature: `${lastfm.username}:${lastfm.API_KEY || 'default'}`,
                fetchRange: (startSec, endSec, options) => this._fetchLastFmListens(lastfm, startSec, endSec, options),
            });
        }

        if (librefm?.isAuthenticated() && librefm.username) {
            sources.push({
                id: 'librefm',
                label: 'Libre.fm',
                signature: librefm.username,
                fetchRange: (startSec, endSec, options) =>
                    this._fetchLibreFmListens(librefm, startSec, endSec, options),
            });
        }

        if (listenbrainz?.isEnabled() && listenbrainz.getToken()) {
            const tokenPrefix = listenbrainz.getToken().slice(0, 8);
            sources.push({
                id: 'listenbrainz',
                label: 'ListenBrainz',
                signature: `${listenbrainz.getApiUrl()}:${tokenPrefix}`,
                fetchRange: (startSec, endSec, options) =>
                    this._fetchListenBrainzListens(listenbrainz, startSec, endSec, options),
            });
        }

        if (maloja?.isEnabled() && maloja.getApiUrl()) {
            const tokenPrefix = (maloja.getApiKey() || '').slice(0, 8);
            sources.push({
                id: 'maloja',
                label: 'Maloja',
                signature: `${maloja.getApiUrl()}:${tokenPrefix}`,
                fetchRange: (startSec, endSec, options) => this._fetchMalojaListens(maloja, startSec, endSec, options),
            });
        }

        return sources;
    }

    async _fetchLastFmListens(lastfm, startSec, endSec, options = {}) {
        const maxPages = options.maxPages || MAX_PAGE_REQUESTS;
        const listens = [];
        let page = 1;
        let totalPages = 1;

        while (page <= totalPages && page <= maxPages) {
            const data = await lastfm.makeRequest(
                'user.getRecentTracks',
                {
                    user: lastfm.username,
                    from: startSec,
                    to: endSec,
                    limit: LASTFM_PAGE_SIZE,
                    page,
                    extended: 1,
                },
                false
            );

            const recentTracks = data?.recenttracks;
            const tracks = Array.isArray(recentTracks?.track)
                ? recentTracks.track
                : recentTracks?.track
                  ? [recentTracks.track]
                  : [];

            for (const track of tracks) {
                if (track?.['@attr']?.nowplaying === 'true') continue;
                const timestamp = parseInt(track?.date?.uts, 10);
                if (!timestamp || timestamp < startSec || timestamp > endSec) continue;

                const imageList = Array.isArray(track.image) ? track.image : [];
                const albumCover =
                    imageList
                        .slice()
                        .reverse()
                        .find((img) => img?.['#text'])?.['#text'] || null;

                listens.push({
                    timestamp: timestamp * 1000,
                    trackId: track.mbid || null,
                    title: track.name || '',
                    duration: parseInt(track.duration, 10) || 0,
                    artistName: track.artist?.name || track.artist?.['#text'] || '',
                    artistId: track.artist?.mbid || null,
                    artistPicture: null,
                    albumTitle: track.album?.['#text'] || track.album?.name || '',
                    albumId: track.album?.mbid || null,
                    albumCover,
                });
            }

            const totalPagesRaw = recentTracks?.['@attr']?.totalPages || recentTracks?.['@attr']?.totalpages || '1';
            totalPages = Math.max(1, parseInt(totalPagesRaw, 10) || 1);

            if (tracks.length < LASTFM_PAGE_SIZE) break;
            page++;
        }

        return listens;
    }

    async _fetchLibreFmListens(librefm, startSec, endSec, options = {}) {
        const maxPages = options.maxPages || MAX_PAGE_REQUESTS;
        const listens = [];
        let page = 1;
        let totalPages = 1;

        while (page <= totalPages && page <= maxPages) {
            const data = await librefm.makeRequest(
                'user.getRecentTracks',
                {
                    user: librefm.username,
                    from: startSec,
                    to: endSec,
                    limit: LASTFM_PAGE_SIZE,
                    page,
                    extended: 1,
                },
                true
            );

            const recentTracks = data?.recenttracks;
            const tracks = Array.isArray(recentTracks?.track)
                ? recentTracks.track
                : recentTracks?.track
                  ? [recentTracks.track]
                  : [];

            for (const track of tracks) {
                if (track?.['@attr']?.nowplaying === 'true') continue;
                const timestamp = parseInt(track?.date?.uts, 10);
                if (!timestamp || timestamp < startSec || timestamp > endSec) continue;

                const imageList = Array.isArray(track.image) ? track.image : [];
                const albumCover =
                    imageList
                        .slice()
                        .reverse()
                        .find((img) => img?.['#text'])?.['#text'] || null;

                listens.push({
                    timestamp: timestamp * 1000,
                    trackId: track.mbid || null,
                    title: track.name || '',
                    duration: parseInt(track.duration, 10) || 0,
                    artistName: track.artist?.name || track.artist?.['#text'] || '',
                    artistId: track.artist?.mbid || null,
                    artistPicture: null,
                    albumTitle: track.album?.['#text'] || track.album?.name || '',
                    albumId: track.album?.mbid || null,
                    albumCover,
                });
            }

            const totalPagesRaw = recentTracks?.['@attr']?.totalPages || recentTracks?.['@attr']?.totalpages || '1';
            totalPages = Math.max(1, parseInt(totalPagesRaw, 10) || 1);

            if (tracks.length < LASTFM_PAGE_SIZE) break;
            page++;
        }

        return listens;
    }

    async _fetchListenBrainzListens(listenbrainz, startSec, endSec, options = {}) {
        const username = await this._getListenBrainzUsername(listenbrainz);
        if (!username) return [];

        const maxPages = options.maxPages || MAX_PAGE_REQUESTS;
        const apiUrl = listenbrainz.getApiUrl().replace(/\/$/, '');
        const token = listenbrainz.getToken();

        const listens = [];
        let cursor = endSec;

        for (let page = 0; page < maxPages; page++) {
            const params = new URLSearchParams({
                min_ts: String(startSec),
                max_ts: String(cursor),
                count: String(LISTENBRAINZ_PAGE_SIZE),
            });

            const response = await fetch(
                `${apiUrl}/user/${encodeURIComponent(username)}/listens?${params.toString()}`,
                {
                    headers: {
                        Authorization: `Token ${token}`,
                    },
                }
            );

            if (!response.ok) {
                throw new Error(`ListenBrainz fetch failed (${response.status})`);
            }

            const data = await response.json();
            const chunk = Array.isArray(data?.payload?.listens) ? data.payload.listens : [];
            if (chunk.length === 0) break;

            let oldestTimestamp = cursor;
            for (const listen of chunk) {
                const timestamp = parseInt(listen?.listened_at, 10);
                if (!timestamp || timestamp < startSec || timestamp > endSec) continue;

                const metadata = listen.track_metadata || {};
                const additionalInfo = metadata.additional_info || {};

                const durationMs = Number(additionalInfo.duration_ms);
                const durationSec = Number(additionalInfo.duration);
                const duration =
                    Number.isFinite(durationMs) && durationMs > 0
                        ? Math.round(durationMs / 1000)
                        : Number.isFinite(durationSec) && durationSec > 0
                          ? Math.round(durationSec)
                          : 0;

                listens.push({
                    timestamp: timestamp * 1000,
                    trackId: null,
                    title: metadata.track_name || '',
                    duration,
                    artistName: metadata.artist_name || '',
                    artistId: null,
                    artistPicture: null,
                    albumTitle: metadata.release_name || '',
                    albumId: null,
                    albumCover: null,
                });

                if (timestamp < oldestTimestamp) {
                    oldestTimestamp = timestamp;
                }
            }

            if (oldestTimestamp >= cursor) break;
            if (chunk.length < LISTENBRAINZ_PAGE_SIZE) break;

            cursor = oldestTimestamp - 1;
            if (cursor < startSec) break;
        }

        return listens;
    }

    async _getListenBrainzUsername(listenbrainz) {
        const token = listenbrainz.getToken();
        if (!token) return null;

        if (this._listenBrainzIdentity.token === token && this._listenBrainzIdentity.username) {
            return this._listenBrainzIdentity.username;
        }

        const apiUrl = listenbrainz.getApiUrl().replace(/\/$/, '');
        const attempts = [
            {
                url: `${apiUrl}/validate-token`,
                options: {
                    headers: {
                        Authorization: `Token ${token}`,
                    },
                },
            },
            {
                url: `${apiUrl}/validate-token?token=${encodeURIComponent(token)}`,
                options: {},
            },
        ];

        for (const attempt of attempts) {
            try {
                const response = await fetch(attempt.url, attempt.options);
                if (!response.ok) continue;
                const payload = await response.json();
                const username =
                    payload?.user_name ||
                    payload?.username ||
                    payload?.payload?.user_name ||
                    payload?.valid?.user_name ||
                    null;
                if (username) {
                    this._listenBrainzIdentity = { token, username };
                    return username;
                }
            } catch {
                // Ignore and try next strategy
            }
        }

        this._listenBrainzIdentity = { token, username: null };
        return null;
    }

    async _fetchMalojaListens(maloja, startSec, endSec, options = {}) {
        const apiUrl = maloja.getApiUrl().replace(/\/$/, '');
        if (!apiUrl) return [];

        const maxPages = options.maxPages || MAX_PAGE_REQUESTS;
        const token = maloja.getApiKey();
        const query = new URLSearchParams({
            from: String(startSec),
            to: String(endSec),
            perpage: String(MALOJA_PAGE_SIZE),
            page: '0',
        });
        if (token) {
            query.set('key', token);
        }

        const listens = [];
        const visitedPages = new Set();
        let nextUrl = `${apiUrl}/apis/mlj_1/scrobbles?${query.toString()}`;

        for (let page = 0; page < maxPages && nextUrl; page++) {
            if (visitedPages.has(nextUrl)) break;
            visitedPages.add(nextUrl);

            const response = await fetch(nextUrl);
            if (!response.ok) {
                throw new Error(`Maloja fetch failed (${response.status})`);
            }

            const data = await response.json();
            const chunk = Array.isArray(data?.list) ? data.list : [];

            for (const entry of chunk) {
                const timestamp = parseInt(entry?.time, 10);
                if (!timestamp || timestamp < startSec || timestamp > endSec) continue;

                const track = entry.track || {};
                const artists = Array.isArray(track.artists) ? track.artists : track.artist ? [track.artist] : [];

                listens.push({
                    timestamp: timestamp * 1000,
                    trackId: null,
                    title: track.title || '',
                    duration: parseInt(entry.duration, 10) || parseInt(track.length, 10) || 0,
                    artistName: artists.join(', '),
                    artistId: null,
                    artistPicture: null,
                    albumTitle: track.album?.title || entry.album?.title || '',
                    albumId: null,
                    albumCover: null,
                });
            }

            const nextPagePath = data?.pagination?.next_page;
            if (nextPagePath) {
                nextUrl = nextPagePath.startsWith('http')
                    ? nextPagePath
                    : `${apiUrl}${nextPagePath.startsWith('/') ? '' : '/'}${nextPagePath}`;
                continue;
            }

            if (chunk.length < MALOJA_PAGE_SIZE) break;
            nextUrl = null;
        }

        return listens;
    }
}

export const exposedManager = new ExposedManager();
