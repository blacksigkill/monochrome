//js/exposed.js
import { db } from './db.js';
import { exposedSettings, lastFMStorage } from './storage.js';
import { syncManager } from './accounts/pocketbase.js';
import { authManager } from './accounts/auth.js';

class ExposedManager {
    constructor() {
        this._timer = null;
        this._elapsed = 0;
        this._threshold = 0;
        this._currentTrack = null;
        this._startTime = 0;
        this._logged = false;
    }

    onTrackChange(track, audioPlayer) {
        this._clearTimer();
        this._logged = false;
        this._elapsed = 0;
        this._currentTrack = track;

        if (!track || !track.id) return;

        const duration = track.duration || audioPlayer.duration || 0;
        if (duration <= 0) return;

        const percentage = lastFMStorage.getScrobblePercentage() || 75;
        // Cap at 240 seconds (same as Last.fm / scrobbler convention)
        this._threshold = Math.min((duration * percentage) / 100, 240);
        this._startTime = Date.now();
        this._startTimer();
    }

    onPause() {
        if (this._timer) {
            this._elapsed += (Date.now() - this._startTime) / 1000;
            clearInterval(this._timer);
            this._timer = null;
        }
    }

    onResume(track, audioPlayer) {
        if (!this._currentTrack || this._currentTrack.id !== track?.id) {
            this.onTrackChange(track, audioPlayer);
            return;
        }
        if (this._logged) return;
        this._startTime = Date.now();
        this._startTimer();
    }

    onPlaybackStop() {
        this._clearTimer();
        this._currentTrack = null;
        this._logged = false;
        this._elapsed = 0;
    }

    _startTimer() {
        if (this._timer) clearInterval(this._timer);
        this._timer = setInterval(() => {
            const totalElapsed = this._elapsed + (Date.now() - this._startTime) / 1000;
            if (totalElapsed >= this._threshold && !this._logged) {
                this._logged = true;
                this._logListen(this._currentTrack);
                clearInterval(this._timer);
                this._timer = null;
            }
        }, 1000);
    }

    _clearTimer() {
        if (this._timer) {
            clearInterval(this._timer);
            this._timer = null;
        }
    }

    async _logListen(track) {
        // Check if Exposed is enabled and user is authenticated
        if (!exposedSettings.isEnabled()) return;
        if (!authManager.user) {
            console.warn('[Exposed] Skipping listen log - not authenticated');
            return;
        }

        if (!track || !track.id) return;

        const entry = {
            timestamp: Date.now(),
            trackId: track.id,
            title: track.title || '',
            duration: track.duration || 0,
            artistName: track.artist?.name || track.artists?.[0]?.name || '',
            artistId: track.artist?.id || track.artists?.[0]?.id || null,
            albumTitle: track.album?.title || '',
            albumId: track.album?.id || null,
            albumCover: track.album?.cover || null,
        };
        try {
            // Store locally
            await db.addExposedListen(entry);
            // Sync to cloud immediately
            await syncManager.addExposedListen(entry);
        } catch (e) {
            console.error('[Exposed] Failed to log listen:', e);
        }
    }

    async computeMonthlyStats(year, month) {
        const start = new Date(year, month - 1, 1).getTime();
        const end = new Date(year, month, 1).getTime();
        const listens = await db.getExposedListens(start, end);

        if (listens.length === 0) {
            return null;
        }

        const trackCounts = {};
        const artistCounts = {};
        const albumCounts = {};
        const dailyActivity = {};
        let totalDuration = 0;

        for (const listen of listens) {
            // Track counts
            const tKey = listen.trackId;
            if (!trackCounts[tKey]) {
                trackCounts[tKey] = {
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
            trackCounts[tKey].count++;

            // Artist counts
            if (listen.artistName) {
                const aKey = listen.artistId || listen.artistName;
                if (!artistCounts[aKey]) {
                    artistCounts[aKey] = {
                        id: listen.artistId,
                        name: listen.artistName,
                        count: 0,
                    };
                }
                artistCounts[aKey].count++;
            }

            // Album counts
            if (listen.albumTitle) {
                const alKey = listen.albumId || listen.albumTitle;
                if (!albumCounts[alKey]) {
                    albumCounts[alKey] = {
                        id: listen.albumId,
                        title: listen.albumTitle,
                        artistName: listen.artistName,
                        cover: listen.albumCover,
                        count: 0,
                    };
                }
                albumCounts[alKey].count++;
            }

            // Daily activity
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

        const uniqueArtists = Object.keys(artistCounts).length;

        // Find peak day
        let peakDay = 0;
        let peakCount = 0;
        for (const [day, count] of Object.entries(dailyActivity)) {
            if (count > peakCount) {
                peakCount = count;
                peakDay = parseInt(day);
            }
        }

        // Build full daily array for the month
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
        const listens = await db.getAllExposedListens();
        const months = new Set();
        for (const listen of listens) {
            const d = new Date(listen.timestamp);
            months.add(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
        }
        return Array.from(months).sort();
    }

    async syncAllListens() {
        if (!authManager.user) {
            throw new Error('Not authenticated');
        }

        try {
            // Get all local listens
            const localListens = await db.getAllExposedListens();

            // Sync to cloud and get merged result
            const mergedListens = await syncManager.syncExposedListens(localListens);

            // Find cloud listens that we don't have locally
            const localKeys = new Set(localListens.map(l => `${l.timestamp}-${l.trackId}`));
            const newFromCloud = mergedListens.filter(l => !localKeys.has(`${l.timestamp}-${l.trackId}`));

            // Add cloud listens to local IndexedDB
            if (newFromCloud.length > 0) {
                for (const listen of newFromCloud) {
                    await db.addExposedListen(listen);
                }
            }

            return {
                local: localListens.length,
                cloud: mergedListens.length,
                addedFromCloud: newFromCloud.length,
            };
        } catch (e) {
            console.error('[Exposed] Failed to sync listens:', e);
            throw e;
        }
    }
}

export const exposedManager = new ExposedManager();
