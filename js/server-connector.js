// js/server-connector.js
// Connects to monochrome-server for player sync & remote control.

import { auth } from './accounts/config.js';
import { authManager } from './accounts/auth.js';
import { serverSettings } from './storage.js';

class ServerConnector {
    static #instance = null;

    static get instance() {
        return ServerConnector.#instance;
    }

    constructor(player) {
        this.player = player;
        this.ws = null;
        this.instanceId = null;
        this.reconnectTimer = null;
        this.syncTimer = null;
        this.lastStateJson = null;
        this.connected = false;
        this._tidalEventsSetup = false;
        this._lastTidalTokenSent = null;
    }

    static initialize(player) {
        if (ServerConnector.#instance) return ServerConnector.#instance;

        const connector = new ServerConnector(player);
        ServerConnector.#instance = connector;

        // Always listen for auth state changes so connect() works whenever called
        authManager.onAuthStateChanged((user) => {
            if (user && serverSettings.isEnabled() && serverSettings.getUrl()) {
                connector.connect();
            } else if (!user) {
                connector.disconnect();
            }
        });

        // Auto-connect if already enabled and user is already logged in
        if (serverSettings.isEnabled() && serverSettings.getUrl() && authManager.user) {
            connector.connect();
        }

        return connector;
    }

    // ─── Tidal credentials

    async _sendTidalCredentials() {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

        try {
            const { HiFiClient } = await import('./HiFi.ts');
            const client = HiFiClient.instance;
            if (!client) return;

            if (!client.token) {
                await client.fetchToken().catch(() => null);
            }

            if (!client.token) return;
            if (client.token === this._lastTidalTokenSent) return;

            this.ws.send(JSON.stringify({
                type: 'tidal:credentials',
                token: client.token,
                refreshToken: client.refreshToken || undefined,
                expiry: client.appTokenExpiry || undefined,
            }));
            this._lastTidalTokenSent = client.token;
        } catch (e) {
            console.warn('[server] Failed to send Tidal credentials:', e.message);
        }
    }

    _setupTidalTokenListener() {
        if (this._tidalEventsSetup) return;
        this._tidalEventsSetup = true;

        import('./HiFi.ts').then(({ HiFiClient, HiFiClientEvents }) => {
            const client = HiFiClient.instance;
            if (!client) return;

            client.on(HiFiClientEvents.TokenUpdate, (token) => {
                this._sendTidalCredentials();
            });
            client.on(HiFiClientEvents.RefreshTokenUpdate, () => {
                this._sendTidalCredentials();
            });
        }).catch(() => {});
    }

    // ─── Appwrite JWT

    async _getJwt() {
        try {
            const result = await auth.createJWT();
            return result.jwt;
        } catch (e) {
            console.warn('[server] Failed to create JWT:', e.message);
            return null;
        }
    }

    // ─── Connection

    async connect() {
        if (this.ws) this.disconnect();

        const url = serverSettings.getUrl();
        if (!url || !authManager.user) {
            console.warn('[server] Cannot connect: missing URL or not logged in', { url, loggedIn: !!authManager.user });
            return;
        }

        const token = await this._getJwt();
        if (!token) return;

        console.log('[server] Connecting to', url);
        const wsUrl = url.replace(/^http/, 'ws') + '/ws?token=' + encodeURIComponent(token);

        try {
            this.ws = new WebSocket(wsUrl);
        } catch (e) {
            console.error('[server] WebSocket creation failed:', e);
            this.scheduleReconnect();
            return;
        }

        this.ws.onopen = () => {
            console.log('[server] Connected');
            this.connected = true;
            this.updateStatusUI(true);

            // Register this instance
            this.ws.send(JSON.stringify({
                type: 'register',
                instanceName: serverSettings.getInstanceName(),
            }));

            // Set up listener for Tidal token changes
            this._setupTidalTokenListener();

            // Start periodic state sync
            this.startSync();
        };

        this.ws.onmessage = (e) => {
            try {
                const msg = JSON.parse(e.data);
                this.handleMessage(msg);
            } catch { /* ignore malformed */ }
        };

        this.ws.onclose = () => {
            console.log('[server] Disconnected');
            this.connected = false;
            this.instanceId = null;
            this.stopSync();
            this.updateStatusUI(false);
            if (serverSettings.isEnabled()) {
                this.scheduleReconnect();
            }
        };

        this.ws.onerror = () => {
            // onclose will fire after this
        };
    }

    disconnect() {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
        this.stopSync();
        this._lastTidalTokenSent = null;
        if (this.ws) {
            this.ws.onclose = null; // prevent reconnect
            this.ws.close();
            this.ws = null;
        }
        this.connected = false;
        this.instanceId = null;
        this.updateStatusUI(false);
    }

    scheduleReconnect() {
        if (this.reconnectTimer) return;
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            if (serverSettings.isEnabled() && authManager.user) {
                this.connect();
            }
        }, 5000);
    }

    // ─── Message handling

    handleMessage(msg) {
        switch (msg.type) {
            case 'registered':
                this.instanceId = msg.instanceId;
                console.log('[server] Registered as', msg.instanceId);
                // Send initial Tidal credentials
                this._sendTidalCredentials();
                // Send initial state
                this.syncState();
                break;

            case 'remote:command':
                this.executeCommand(msg.command);
                break;

            case 'sync:state':
                // State from another instance — emit event for UI
                window.dispatchEvent(new CustomEvent('server:remote-state', { detail: msg }));
                break;

            case 'pong':
                break;
        }
    }

    executeCommand(command) {
        if (!command || !this.player) return;
        const p = this.player;
        const el = p.activeElement;

        switch (command.action) {
            case 'play':
                el?.play();
                break;
            case 'pause':
                el?.pause();
                break;
            case 'next':
                p.playNext?.();
                break;
            case 'prev':
                p.playPrev?.();
                break;
            case 'seek':
                if (el && typeof command.payload === 'number') {
                    el.currentTime = command.payload;
                }
                break;
            case 'volume':
                if (typeof command.payload === 'number') {
                    p.setVolume?.(command.payload);
                }
                break;
            case 'shuffle':
                p.toggleShuffle?.();
                break;
            case 'repeat':
                p.toggleRepeat?.();
                break;
            default:
                console.log('[server] Unknown command:', command.action);
        }
    }

    // ─── State Sync

    startSync() {
        this.stopSync();
        // Sync every 3 seconds + on key events
        this.syncTimer = setInterval(() => this.syncState(), 3000);

        // Also sync on play/pause/track change
        const el = this.player?.activeElement;
        if (el) {
            el.addEventListener('play', this._onPlayPause);
            el.addEventListener('pause', this._onPlayPause);
            el.addEventListener('ended', this._onPlayPause);
        }
    }

    _onPlayPause = () => {
        this.syncState();
    };

    stopSync() {
        if (this.syncTimer) {
            clearInterval(this.syncTimer);
            this.syncTimer = null;
        }
        const el = this.player?.activeElement;
        if (el) {
            el.removeEventListener('play', this._onPlayPause);
            el.removeEventListener('pause', this._onPlayPause);
            el.removeEventListener('ended', this._onPlayPause);
        }
    }

    syncState() {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.instanceId) return;

        this._sendTidalCredentials().catch(() => {});

        const p = this.player;
        const el = p?.activeElement;
        if (!el) return;

        const REPEAT_MAP = { 0: 'OFF', 1: 'ALL', 2: 'ONE' };

        const state = {
            currentTrack: p.currentTrack || null,
            queue: (p.getCurrentQueue?.() || []).slice(0, 50), // Cap to avoid huge payloads
            queueIndex: p.currentQueueIndex ?? -1,
            isPlaying: !el.paused,
            position: el.currentTime || 0,
            shuffle: !!p.shuffleActive,
            repeatMode: REPEAT_MAP[p.repeatMode] || 'OFF',
            volume: p.userVolume ?? 1,
        };

        const json = JSON.stringify(state);
        if (json === this.lastStateJson) return; // No change
        this.lastStateJson = json;

        this.ws.send(JSON.stringify({ type: 'sync:state', state }));
    }

    // ─── UI ───

    updateStatusUI(connected) {
        const dot = document.getElementById('server-status-dot');
        if (dot) {
            dot.style.background = connected ? '#34d399' : '#f87171';
            // Update the text node next to the dot (sibling text, not the dot itself)
            const label = dot.parentElement;
            if (label) {
                // Find or update the text node after the dot
                let textNode = dot.nextSibling;
                while (textNode && textNode.nodeType !== Node.TEXT_NODE) {
                    textNode = textNode.nextSibling;
                }
                if (textNode) {
                    textNode.textContent = connected ? ' Connected' : ' Disconnected';
                }
            }
        }
    }
}

export { ServerConnector, serverSettings };
