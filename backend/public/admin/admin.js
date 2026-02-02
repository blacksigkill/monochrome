const input = document.getElementById('filename-template');
const qualitySelect = document.getElementById('download-quality');
const preview = document.getElementById('filename-preview');
const saveBtn = document.getElementById('save-btn');
const resetBtn = document.getElementById('reset-btn');
const status = document.getElementById('status');
const dbTableSelect = document.getElementById('db-table');
const dbTableView = document.getElementById('db-table-view');
const dbTableHead = dbTableView.querySelector('thead');
const dbTableBody = dbTableView.querySelector('tbody');
const loadTableBtn = document.getElementById('load-table-btn');
const rowEditor = document.getElementById('row-editor');
const rowEditorHelp = document.getElementById('row-editor-help');
const saveRowBtn = document.getElementById('save-row-btn');
const dbStatus = document.getElementById('db-status');

const DEFAULT_TEMPLATE = '{trackNumber} - {artist} - {title}';
const DEFAULT_QUALITY = 'player';
let dbState = {
    table: null,
    primaryKey: null,
    rows: [],
};
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

const setDbStatus = (message, state) => {
    dbStatus.textContent = message;
    if (state) {
        dbStatus.dataset.state = state;
    } else {
        delete dbStatus.dataset.state;
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

const loadTables = async () => {
    try {
        const response = await fetch('/api/admin/db/tables');
        if (!response.ok) {
            throw new Error(`Request failed with status ${response.status}`);
        }

        const payload = await response.json();
        dbTableSelect.innerHTML = '';
        payload.tables.forEach((table) => {
            const option = document.createElement('option');
            option.value = table;
            option.textContent = table;
            dbTableSelect.appendChild(option);
        });
    } catch (error) {
        setDbStatus(`Failed to load tables: ${error.message}`, 'error');
    }
};

const renderTable = (columns, rows, primaryKey) => {
    dbTableHead.innerHTML = '';
    dbTableBody.innerHTML = '';

    const headerRow = document.createElement('tr');
    columns.forEach((column) => {
        const th = document.createElement('th');
        th.textContent = column.name;
        headerRow.appendChild(th);
    });
    dbTableHead.appendChild(headerRow);

    rows.forEach((row, index) => {
        const tr = document.createElement('tr');
        columns.forEach((column) => {
            const td = document.createElement('td');
            const value = row[column.name];
            td.textContent = value === null || value === undefined ? '' : String(value);
            tr.appendChild(td);
        });
        tr.addEventListener('click', () => {
            dbTableBody.querySelectorAll('tr').forEach((rowEl) => rowEl.classList.remove('is-selected'));
            tr.classList.add('is-selected');
            const selected = rows[index];
            rowEditor.value = JSON.stringify(selected, null, 2);
            const pkValue = primaryKey ? selected[primaryKey] : '';
            rowEditor.dataset.pkValue = pkValue === null || pkValue === undefined ? '' : String(pkValue);
            rowEditorHelp.textContent = primaryKey
                ? `Editing row where ${primaryKey} = ${pkValue}`
                : 'Primary key not available.';
        });
        dbTableBody.appendChild(tr);
    });
};

const loadTableData = async () => {
    const tableName = dbTableSelect.value;
    if (!tableName) return;

    try {
        setDbStatus('Loading table...');
        const response = await fetch(`/api/admin/db/table/${encodeURIComponent(tableName)}?limit=50`);
        if (!response.ok) {
            throw new Error(`Request failed with status ${response.status}`);
        }

        const payload = await response.json();
        dbState = {
            table: payload.table,
            primaryKey: payload.primaryKey,
            rows: payload.rows,
        };
        renderTable(payload.columns, payload.rows, payload.primaryKey);
        setDbStatus('Table loaded.', 'success');
    } catch (error) {
        setDbStatus(`Failed to load table: ${error.message}`, 'error');
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

if (loadTableBtn) {
    loadTableBtn.addEventListener('click', loadTableData);
}

if (saveRowBtn) {
    saveRowBtn.addEventListener('click', async () => {
        if (!dbState.table || !dbState.primaryKey) {
            setDbStatus('No table or primary key selected.', 'error');
            return;
        }

        const pkValue = rowEditor.dataset.pkValue;
        if (!pkValue) {
            setDbStatus('Select a row to edit.', 'error');
            return;
        }

        let parsed;
        try {
            parsed = JSON.parse(rowEditor.value);
        } catch (error) {
            setDbStatus(`Invalid JSON: ${error.message}`, 'error');
            return;
        }

        const { [dbState.primaryKey]: _, ...data } = parsed;
        if (dbState.table === 'metadata' && typeof data.raw_json === 'object') {
            data.raw_json = JSON.stringify(data.raw_json);
        }
        if (Object.keys(data).length === 0) {
            setDbStatus('No editable fields found.', 'error');
            return;
        }

        try {
            setDbStatus('Saving row...');
            const response = await fetch('/api/admin/db/row', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    table: dbState.table,
                    key: dbState.primaryKey,
                    value: pkValue,
                    data,
                }),
            });

            if (!response.ok) {
                const payload = await response.json().catch(() => ({}));
                throw new Error(payload.error || `Request failed with status ${response.status}`);
            }

            setDbStatus('Row updated.', 'success');
            await loadTableData();
        } catch (error) {
            setDbStatus(`Failed to update row: ${error.message}`, 'error');
        }
    });
}

input.addEventListener('input', () => {
    updatePreview();
    if (status.textContent) {
        setStatus('');
    }
});

loadPreferences();
loadTables();
