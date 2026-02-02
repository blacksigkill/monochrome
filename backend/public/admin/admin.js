const input = document.getElementById('filename-template');
const qualitySelect = document.getElementById('download-quality');
const preview = document.getElementById('filename-preview');
const saveBtn = document.getElementById('save-btn');
const resetBtn = document.getElementById('reset-btn');
const status = document.getElementById('status');

const DEFAULT_TEMPLATE = '{trackNumber} - {artist} - {title}';
const DEFAULT_QUALITY = 'player';
const SAMPLE_DATA = {
    trackNumber: 1,
    artist: 'Daft Punk',
    title: 'Digital Love',
    album: 'Discovery',
    albumArtist: 'Daft Punk',
    albumTitle: 'Discovery',
    year: '2001',
};

const sanitizeForFilename = (value) => {
    if (!value) return 'Unknown';
    return value
        .replace(/[\\/:*?"<>|]/g, '_')
        .replace(/\s+/g, ' ')
        .trim();
};

const formatTemplate = (template, data) => {
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

const setStatus = (message, state) => {
    status.textContent = message;
    if (state) {
        status.dataset.state = state;
    } else {
        delete status.dataset.state;
    }
};

const updatePreview = () => {
    const template = input.value.trim() || DEFAULT_TEMPLATE;
    preview.textContent = `${formatTemplate(template, SAMPLE_DATA)}.flac`;
};

const loadPreferences = async () => {
    try {
        const response = await fetch('/api/admin/preferences');
        if (!response.ok) {
            throw new Error(`Request failed with status ${response.status}`);
        }

        const preferences = await response.json();
        input.value = preferences.filenameTemplate || DEFAULT_TEMPLATE;
        if (qualitySelect) {
            qualitySelect.value = preferences.downloadQuality || DEFAULT_QUALITY;
        }
        updatePreview();
    } catch (error) {
        setStatus(`Failed to load preferences: ${error.message}`, 'error');
    }
};

saveBtn.addEventListener('click', async () => {
    const template = input.value.trim();
    if (!template) {
        setStatus('Filename template cannot be empty.', 'error');
        return;
    }

    try {
        setStatus('Saving preferences...');
        const response = await fetch('/api/admin/preferences', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                filenameTemplate: template,
                downloadQuality: qualitySelect ? qualitySelect.value : DEFAULT_QUALITY,
            }),
        });

        if (!response.ok) {
            const payload = await response.json().catch(() => ({}));
            throw new Error(payload.error || `Request failed with status ${response.status}`);
        }

        setStatus('Preferences saved.', 'success');
        updatePreview();
    } catch (error) {
        setStatus(`Failed to save preferences: ${error.message}`, 'error');
    }
});

resetBtn.addEventListener('click', async () => {
    input.value = DEFAULT_TEMPLATE;
    if (qualitySelect) {
        qualitySelect.value = DEFAULT_QUALITY;
    }
    updatePreview();
    saveBtn.click();
});

input.addEventListener('input', () => {
    updatePreview();
    if (status.textContent) {
        setStatus('');
    }
});

loadPreferences();
