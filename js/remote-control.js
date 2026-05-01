import { showNotification } from './downloads.js';
import { sidePanelManager } from './side-panel.js';
import { ServerConnector } from './server-connector.js';
import { escapeHtml, formatTime, getTrackArtists, getTrackTitle } from './utils.js';

const remotePanelState = {
    targets: [],
    selectedInstanceId: null,
    isLoading: false,
};

export function initializeRemoteControl() {
    document.getElementById('remote-control-btn')?.addEventListener('click', () => openRemoteControlPanel());

    window.addEventListener('server:remote-state', handleRemoteStateUpdate);
    window.addEventListener('server:remote-offline', handleRemoteOffline);
    window.addEventListener('server:remote-reset', handleRemoteReset);
}

async function openRemoteControlPanel() {
    const connector = ServerConnector.instance;
    if (!connector) return;

    const shouldClosePanel = sidePanelManager.isActive('remote');
    remotePanelState.isLoading = true;
    sidePanelManager.open('remote', 'Remote Control', renderRemoteControls, renderRemoteContent);
    if (shouldClosePanel) return;

    try {
        await reloadRemoteTargets();
    } catch (error) {
        remotePanelState.isLoading = false;
        showNotification(error?.message || 'Failed to load remote instances.');
    }

    await refreshRemotePanel();
}

async function reloadRemoteTargets({ forceStateRefresh = false } = {}) {
    const connector = ServerConnector.instance;
    if (!connector) return;

    remotePanelState.isLoading = true;
    await refreshRemotePanel();

    try {
        const targets = await connector.getRemoteTargets();
        const filteredTargets = targets.filter((target) => target.id !== connector.instanceId);

        await Promise.all(
            filteredTargets.map((target) => connector.fetchRemoteState(target.id, { force: forceStateRefresh }).catch(() => null))
        );

        remotePanelState.targets = filteredTargets;

        if (!filteredTargets.some((target) => target.id === remotePanelState.selectedInstanceId)) {
            remotePanelState.selectedInstanceId = filteredTargets[0]?.id || null;
        }
    } finally {
        remotePanelState.isLoading = false;
    }
}

function renderRemoteControls(container) {
    container.innerHTML = `
        <button id="remote-panel-refresh-btn" class="remote-panel-refresh-btn" title="Refresh remote instances">Refresh</button>
    `;

    container.querySelector('#remote-panel-refresh-btn')?.addEventListener('click', async () => {
        try {
            await reloadRemoteTargets({ forceStateRefresh: true });
            await refreshRemotePanel();
        } catch (error) {
            remotePanelState.isLoading = false;
            showNotification(error?.message || 'Failed to refresh remote instances.');
        }
    });
}

function renderRemoteContent(container) {
    if (remotePanelState.isLoading) {
        container.innerHTML = '<div class="remote-panel-empty">Loading remote players...</div>';
        return;
    }

    if (!remotePanelState.targets.length) {
        container.innerHTML = `
            <div class="remote-panel-empty">
                <strong>No other instance is connected.</strong>
                <span>Open Monochrome on another device or browser tab connected to your backend server.</span>
            </div>
        `;
        return;
    }

    const connector = ServerConnector.instance;
    const selectedTarget = remotePanelState.targets.find((target) => target.id === remotePanelState.selectedInstanceId)
        || remotePanelState.targets[0];

    if (!selectedTarget) {
        container.innerHTML = '<div class="remote-panel-empty">No remote player selected.</div>';
        return;
    }

    remotePanelState.selectedInstanceId = selectedTarget.id;
    const selectedState = connector?.getCachedRemoteState(selectedTarget.id) || null;
    const currentTrack = selectedState?.currentTrack || null;
    const currentPosition = selectedState?.position || 0;
    const totalDuration = currentTrack?.duration || 0;
    const progressMax = totalDuration > 0 ? totalDuration : 1;
    const progressValue = Math.min(currentPosition, progressMax);
    const volumePercent = Math.round((selectedState?.volume ?? 1) * 100);

    container.innerHTML = `
        <div class="remote-panel">
            <div class="remote-target-list">
                ${remotePanelState.targets.map((target) => renderTargetButton(target, connector?.getCachedRemoteState(target.id), target.id === selectedTarget.id)).join('')}
            </div>

            <div class="remote-player-card">
                <div class="remote-player-header">
                    <img class="remote-player-cover" src="${escapeHtml(getTrackCoverUrl(currentTrack))}" alt="Remote track cover" />
                    <div class="remote-player-meta">
                        <div class="remote-player-instance">${escapeHtml(selectedTarget.name || 'Remote instance')}</div>
                        <div class="remote-player-title">${escapeHtml(getTrackTitle(currentTrack))}</div>
                        <div class="remote-player-artist">${escapeHtml(getTrackArtists(currentTrack))}</div>
                    </div>
                    <div class="remote-player-status ${selectedState?.isPlaying ? 'playing' : 'paused'}">
                        ${selectedState?.isPlaying ? 'Playing' : 'Paused'}
                    </div>
                </div>

                <div class="remote-player-progress">
                    <span>${formatTime(currentPosition)}</span>
                    <input
                        id="remote-seek-input"
                        type="range"
                        min="0"
                        max="${progressMax}"
                        value="${progressValue}"
                        ${totalDuration > 0 ? '' : 'disabled'}
                    />
                    <span>${formatTime(totalDuration)}</span>
                </div>

                <div class="remote-player-actions">
                    <button data-remote-command="prev">Prev</button>
                    <button data-remote-command="${selectedState?.isPlaying ? 'pause' : 'play'}" class="primary">
                        ${selectedState?.isPlaying ? 'Pause' : 'Play'}
                    </button>
                    <button data-remote-command="next">Next</button>
                </div>

                <div class="remote-player-actions secondary">
                    <button data-remote-command="shuffle" class="${selectedState?.shuffle ? 'active' : ''}">Shuffle</button>
                    <button data-remote-command="repeat" class="${selectedState?.repeatMode && selectedState.repeatMode !== 'OFF' ? 'active' : ''}">
                        Repeat ${escapeHtml(selectedState?.repeatMode || 'OFF')}
                    </button>
                </div>

                <label class="remote-volume-control">
                    <span>Volume</span>
                    <input id="remote-volume-input" type="range" min="0" max="100" value="${volumePercent}" />
                    <span id="remote-volume-value">${volumePercent}%</span>
                </label>

                ${currentTrack ? `
                    <div class="remote-player-footnote">
                        Live state sync comes from the backend server. Actions are sent via the remote plugin.
                    </div>
                ` : `
                    <div class="remote-panel-empty compact">
                        Waiting for the selected instance to report its current player state.
                    </div>
                `}
            </div>
        </div>
    `;

    bindRemotePanelEvents(container, selectedTarget.id);
}

function bindRemotePanelEvents(container, targetInstanceId) {
    container.querySelectorAll('[data-remote-instance]').forEach((button) => {
        button.addEventListener('click', async () => {
            remotePanelState.selectedInstanceId = button.dataset.remoteInstance;
            try {
                await ServerConnector.instance?.fetchRemoteState(remotePanelState.selectedInstanceId, { force: true });
            } catch {
                // Keep the panel open even if this instance has no state yet.
            }
            await refreshRemotePanel();
        });
    });

    container.querySelectorAll('[data-remote-command]').forEach((button) => {
        button.addEventListener('click', async () => {
            try {
                await ServerConnector.instance?.sendRemoteCommand(targetInstanceId, {
                    action: button.dataset.remoteCommand,
                });
            } catch (error) {
                showNotification(error?.message || 'Failed to send remote command.');
            }
        });
    });

    const seekInput = container.querySelector('#remote-seek-input');
    if (seekInput) {
        seekInput.addEventListener('change', async () => {
            try {
                await ServerConnector.instance?.sendRemoteCommand(targetInstanceId, {
                    action: 'seek',
                    payload: Number(seekInput.value),
                });
            } catch (error) {
                showNotification(error?.message || 'Failed to seek remote player.');
            }
        });
    }

    const volumeInput = container.querySelector('#remote-volume-input');
    const volumeValue = container.querySelector('#remote-volume-value');
    if (volumeInput && volumeValue) {
        volumeInput.addEventListener('input', () => {
            volumeValue.textContent = `${volumeInput.value}%`;
        });

        volumeInput.addEventListener('change', async () => {
            try {
                await ServerConnector.instance?.sendRemoteCommand(targetInstanceId, {
                    action: 'volume',
                    payload: Number(volumeInput.value) / 100,
                });
            } catch (error) {
                showNotification(error?.message || 'Failed to change remote volume.');
            }
        });
    }
}

async function refreshRemotePanel() {
    if (!sidePanelManager.isActive('remote')) return;
    await sidePanelManager.refresh('remote', renderRemoteControls, renderRemoteContent);
}

function handleRemoteStateUpdate(event) {
    const detail = event.detail;
    const connector = ServerConnector.instance;
    if (!detail?.instanceId || !connector || detail.instanceId === connector.instanceId) return;

    if (!remotePanelState.targets.some((target) => target.id === detail.instanceId)) {
        remotePanelState.targets = [
            ...remotePanelState.targets,
            { id: detail.instanceId, name: 'Remote instance', online: true },
        ];
    }

    if (!remotePanelState.selectedInstanceId) {
        remotePanelState.selectedInstanceId = detail.instanceId;
    }

    void refreshRemotePanel();
}

function handleRemoteOffline(event) {
    const detail = event.detail;
    if (!detail?.instanceId) return;

    remotePanelState.targets = remotePanelState.targets.filter((target) => target.id !== detail.instanceId);

    if (remotePanelState.selectedInstanceId === detail.instanceId) {
        remotePanelState.selectedInstanceId = remotePanelState.targets[0]?.id || null;
    }

    void refreshRemotePanel();
}

function handleRemoteReset() {
    remotePanelState.targets = [];
    remotePanelState.selectedInstanceId = null;
    remotePanelState.isLoading = false;
    void refreshRemotePanel();
}

function renderTargetButton(target, state, isSelected) {
    return `
        <button class="remote-target-btn ${isSelected ? 'active' : ''}" data-remote-instance="${escapeHtml(target.id)}">
            <span class="remote-target-name">${escapeHtml(target.name || 'Remote instance')}</span>
            <span class="remote-target-subtitle">${escapeHtml(state?.currentTrack ? getTrackTitle(state.currentTrack) : 'Waiting for playback')}</span>
        </button>
    `;
}

function getTrackCoverUrl(track) {
    const cover = track?.album?.cover || track?.cover || track?.artwork;
    if (!cover) return '/assets/appicon.png';
    if (typeof cover === 'string' && cover.startsWith('http')) return cover;
    return `https://resources.tidal.com/images/${String(cover).replace(/-/g, '/')}/320x320.jpg`;
}
