/**
 * Pretty Print System for Rayforce Values
 * Renders Rayforce types as beautiful HTML for the REPL webview
 */

import { RayforceValue, RayforceTable, RayforceDict, RayforceError } from './rayforceIpc';

// ============================================================================
// Configuration
// ============================================================================

export interface PrettyPrintConfig {
    maxTableRows: number;
    maxTableCols: number;
    maxListItems: number;
    maxStringLength: number;
    floatPrecision: number;
    useUnicode: boolean;
}

export interface PaginationInfo {
    historyId: string;
    currentPage: number;
    pageSize: number;
    totalCount: number;
}

const DEFAULT_CONFIG: PrettyPrintConfig = {
    maxTableRows: 20,
    maxTableCols: 10,
    maxListItems: 50,
    maxStringLength: 100,
    floatPrecision: 2,
    useUnicode: true
};

// ============================================================================
// Type Detection
// ============================================================================

export type RayforceTypeName = 
    | 'Null' | 'B8' | 'U8' | 'I16' | 'I32' | 'I64' | 'F64'
    | 'C8' | 'Symbol' | 'Date' | 'Time' | 'Timestamp' | 'GUID'
    | 'List' | 'Dict' | 'Table' | 'Error' | 'Lambda' | 'Unknown';

export function detectType(value: RayforceValue): RayforceTypeName {
    if (value === null) return 'Null';
    if (typeof value === 'boolean') return 'B8';
    if (typeof value === 'bigint') return 'I64';
    if (typeof value === 'number') {
        if (Number.isInteger(value)) return 'I32';
        return 'F64';
    }
    if (typeof value === 'string') return 'C8';
    if (typeof value === 'symbol') return 'Symbol';
    if (value instanceof Date) return 'Timestamp';
    if (Array.isArray(value)) {
        if (value.length === 0) return 'List';
        return detectArrayType(value);
    }
    if (typeof value === 'object' && '_type' in value) {
        if (value._type === 'table') return 'Table';
        if (value._type === 'dict') return 'Dict';
        if (value._type === 'error') return 'Error';
    }
    return 'Unknown';
}

function detectArrayType(arr: RayforceValue[]): RayforceTypeName {
    if (arr.length === 0) return 'List';
    const firstType = detectType(arr[0]);
    // Check if all elements are same type (vector) or mixed (list)
    const isHomogeneous = arr.every(v => detectType(v) === firstType);
    return isHomogeneous ? firstType : 'List';
}

// ============================================================================
// CSS Styles
// ============================================================================

export function getPrettyPrintStyles(): string {
    return `
/* Pretty Print Styles */
.rf-value { font-family: var(--vscode-editor-font-family, 'SF Mono', Consolas, monospace); }
.rf-null { color: var(--vscode-symbolIcon-nullForeground, #6e7681); font-style: italic; }
.rf-bool { color: var(--vscode-symbolIcon-booleanForeground, #79c0ff); font-weight: 600; }
.rf-number { color: var(--vscode-symbolIcon-numberForeground, #a5d6ff); }
.rf-bigint { color: var(--vscode-symbolIcon-numberForeground, #a5d6ff); }
.rf-string { color: var(--vscode-symbolIcon-stringForeground, #a5d6ff); }
.rf-string-quote { color: var(--vscode-symbolIcon-operatorForeground, #8b949e); }
.rf-symbol { color: var(--vscode-symbolIcon-variableForeground, #ffa657); }
.rf-date { color: var(--vscode-symbolIcon-colorForeground, #7ee787); }
.rf-time { color: var(--vscode-symbolIcon-colorForeground, #7ee787); }
.rf-timestamp { color: var(--vscode-symbolIcon-colorForeground, #7ee787); }
.rf-guid { color: var(--vscode-symbolIcon-keyForeground, #d2a8ff); font-size: 0.9em; }
.rf-error { color: var(--vscode-errorForeground, #f85149); }
.rf-error-code { background: var(--vscode-inputValidation-errorBackground, rgba(248, 81, 73, 0.1)); padding: 1px 4px; border-radius: 3px; margin-right: 4px; }
.rf-lambda { color: var(--vscode-symbolIcon-functionForeground, #d2a8ff); }
.rf-type-badge { 
    font-size: 10px; 
    color: var(--vscode-badge-foreground); 
    background: var(--vscode-badge-background); 
    padding: 1px 5px; 
    border-radius: 3px; 
    margin-left: 6px;
    font-weight: 500;
    text-transform: uppercase;
}

/* List/Vector styles */
.rf-list { }
.rf-list-bracket { color: var(--vscode-symbolIcon-operatorForeground, #8b949e); }
.rf-list-items { }
.rf-list-item { margin-right: 6px; }
.rf-list-ellipsis { color: var(--vscode-descriptionForeground, #8b949e); font-style: italic; }

/* Dict styles */
.rf-dict { }
.rf-dict-brace { color: var(--vscode-symbolIcon-operatorForeground, #8b949e); }
.rf-dict-key { color: var(--vscode-symbolIcon-keyForeground, #ffa657); }
.rf-dict-colon { color: var(--vscode-symbolIcon-operatorForeground, #8b949e); margin: 0 4px; }
.rf-dict-entry { margin-right: 8px; }

/* Table styles */
.rf-table-container { 
    margin: 8px 0; 
    overflow-x: auto;
    font-size: 12px;
}
.rf-table {
    border-collapse: collapse;
    border: 1px solid var(--vscode-panel-border, #30363d);
    background: var(--vscode-editor-background);
    width: auto;
    min-width: 200px;
}
.rf-table th, .rf-table td {
    padding: 6px 12px;
    border: 1px solid var(--vscode-panel-border, #30363d);
    text-align: left;
    white-space: nowrap;
}
.rf-table th {
    background: var(--vscode-sideBar-background, #161b22);
    font-weight: 600;
    color: var(--vscode-foreground);
}
.rf-table-type-row th {
    font-weight: normal;
    font-size: 10px;
    color: var(--vscode-descriptionForeground, #8b949e);
    text-transform: uppercase;
    padding: 3px 12px;
    background: var(--vscode-sideBar-background, #161b22);
    border-top: none;
}
.rf-table tr:nth-child(even) td {
    background: var(--vscode-list-hoverBackground, rgba(177, 186, 196, 0.04));
}
.rf-table tr:hover td {
    background: var(--vscode-list-activeSelectionBackground, rgba(177, 186, 196, 0.08));
}
.rf-table-ellipsis-row td {
    text-align: center;
    color: var(--vscode-descriptionForeground, #8b949e);
    font-style: italic;
    padding: 4px;
}
.rf-table-footer {
    display: flex;
    align-items: center;
    background: var(--vscode-sideBar-background, #161b22);
    padding: 4px 8px;
    font-size: 10px;
    color: var(--vscode-descriptionForeground, #8b949e);
    border-top: 1px solid var(--vscode-panel-border, #30363d);
    gap: 8px;
    flex-wrap: wrap;
}
.rf-table-footer-stat {
    white-space: nowrap;
}
.rf-table-footer-stat strong {
    color: var(--vscode-foreground);
}

/* Compact inline table */
.rf-table-inline {
    display: inline;
    color: var(--vscode-descriptionForeground);
}

/* Pagination styles */
.rf-pagination {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    flex: 1;
}
.rf-pagination-info {
    color: var(--vscode-descriptionForeground);
    font-size: 10px;
}
.rf-pagination-info strong {
    color: var(--vscode-foreground);
}
.rf-pagination-controls {
    display: flex;
    align-items: center;
    gap: 2px;
}
.rf-pagination-btn {
    background: var(--vscode-button-secondaryBackground, #3c3c3c);
    color: var(--vscode-button-secondaryForeground, #ccc);
    border: none;
    padding: 2px 5px;
    border-radius: 2px;
    cursor: pointer;
    font-size: 10px;
    font-weight: bold;
    transition: all 0.15s;
    min-width: 22px;
    line-height: 1.2;
}
.rf-pagination-btn:hover:not(:disabled) {
    background: var(--vscode-button-secondaryHoverBackground, #505050);
}
.rf-pagination-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
}
.rf-pagination-page {
    font-size: 10px;
    color: var(--vscode-descriptionForeground);
    padding: 0 6px;
}
.rf-pagination-page strong {
    color: var(--vscode-foreground);
}
.rf-pagination-size {
    display: flex;
    align-items: center;
    gap: 4px;
    margin-left: auto;
}
.rf-pagination-size label {
    font-size: 10px;
    color: var(--vscode-descriptionForeground);
}
.rf-pagination-select {
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent);
    padding: 1px 4px;
    border-radius: 2px;
    font-size: 10px;
    cursor: pointer;
}
.rf-pagination-select:focus {
    outline: 1px solid var(--vscode-focusBorder);
}
`;
}

// ============================================================================
// HTML Formatters
// ============================================================================

export function formatValueHtml(value: RayforceValue, config: PrettyPrintConfig = DEFAULT_CONFIG, pagination?: PaginationInfo): string {
    return `<span class="rf-value">${formatValueInner(value, config, 0, pagination)}</span>`;
}

function formatValueInner(value: RayforceValue, config: PrettyPrintConfig, depth: number, pagination?: PaginationInfo): string {
    if (value === null) {
        return `<span class="rf-null">::</span>`;
    }

    if (typeof value === 'boolean') {
        return `<span class="rf-bool">${value ? 'true' : 'false'}</span>`;
    }

    if (typeof value === 'bigint') {
        // Check for null i64 (-2^63)
        if (value === -9223372036854775808n) {
            return `<span class="rf-null">0N</span>`;
        }
        return `<span class="rf-bigint">${value.toString()}</span>`;
    }

    if (typeof value === 'number') {
        return formatNumber(value, config);
    }

    if (typeof value === 'string') {
        return formatString(value, config);
    }

    if (typeof value === 'symbol') {
        const name = Symbol.keyFor(value) || '';
        return `<span class="rf-symbol">${escapeHtml(name)}</span>`;
    }

    if (value instanceof Date) {
        return formatTimestamp(value);
    }

    if (Array.isArray(value)) {
        return formatArray(value, config, depth, pagination);
    }

    if (typeof value === 'object' && '_type' in value) {
        if (value._type === 'error') {
            return formatError(value as RayforceError);
        }
        if (value._type === 'table') {
            return formatTableHtml(value as RayforceTable, config, pagination);
        }
        if (value._type === 'dict') {
            return formatDictHtml(value as RayforceDict, config, depth);
        }
    }

    return `<span class="rf-null">${escapeHtml(String(value))}</span>`;
}

function formatNumber(n: number, config: PrettyPrintConfig): string {
    if (Number.isNaN(n)) {
        return `<span class="rf-null">0n</span>`;
    }
    if (!Number.isFinite(n)) {
        return `<span class="rf-null">${n > 0 ? '0w' : '-0w'}</span>`;
    }
    
    // Check for null int/long (-2^31 or -2^63 approximations)
    if (n === -2147483648) {
        return `<span class="rf-null">0N</span>`;
    }
    
    let formatted: string;
    if (Number.isInteger(n)) {
        formatted = n.toString();
    } else {
        // Use scientific notation for very large/small numbers
        const absN = Math.abs(n);
        if (absN !== 0 && (absN > 1e6 || absN < 1e-2)) {
            formatted = n.toExponential(config.floatPrecision);
        } else {
            formatted = n.toFixed(config.floatPrecision);
        }
    }
    
    return `<span class="rf-number">${formatted}</span>`;
}

// Format Rayforce date (days since 2000.01.01)
function formatDate(days: number): string {
    if (days === -2147483648) {
        return `<span class="rf-null">0Nd</span>`;
    }
    
    const epoch = new Date(2000, 0, 1);
    const date = new Date(epoch.getTime() + days * 24 * 60 * 60 * 1000);
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    
    return `<span class="rf-date">${y}.${m}.${d}</span>`;
}

// Format Rayforce time (milliseconds since midnight)
function formatTime(ms: number): string {
    if (ms === -2147483648) {
        return `<span class="rf-null">0Nt</span>`;
    }
    
    const sign = ms < 0 ? '-' : '';
    const absMs = Math.abs(ms);
    
    const hours = Math.floor(absMs / (1000 * 60 * 60));
    const mins = Math.floor((absMs % (1000 * 60 * 60)) / (1000 * 60));
    const secs = Math.floor((absMs % (1000 * 60)) / 1000);
    const millis = absMs % 1000;
    
    const h = String(hours).padStart(2, '0');
    const m = String(mins).padStart(2, '0');
    const s = String(secs).padStart(2, '0');
    const ms3 = String(millis).padStart(3, '0');
    
    return `<span class="rf-time">${sign}${h}:${m}:${s}.${ms3}</span>`;
}

function formatString(s: string, config: PrettyPrintConfig): string {
    let display = s;
    let truncated = false;
    
    if (s.length > config.maxStringLength) {
        display = s.substring(0, config.maxStringLength);
        truncated = true;
    }
    
    // Escape special characters for display
    display = display
        .replace(/\n/g, '\\n')
        .replace(/\r/g, '\\r')
        .replace(/\t/g, '\\t');
    
    return `<span class="rf-string"><span class="rf-string-quote">"</span>${escapeHtml(display)}${truncated ? '<span class="rf-list-ellipsis">..</span>' : ''}<span class="rf-string-quote">"</span></span>`;
}

function formatTimestamp(d: Date): string {
    const pad = (n: number, len: number = 2) => n.toString().padStart(len, '0');
    const formatted = `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())}D${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
    return `<span class="rf-timestamp">${formatted}</span>`;
}

function formatArray(arr: RayforceValue[], config: PrettyPrintConfig, depth: number, pagination?: PaginationInfo): string {
    if (arr.length === 0) {
        return `<span class="rf-list"><span class="rf-list-bracket">()</span></span>`;
    }

    const isVector = isHomogeneousArray(arr);
    const openBracket = isVector ? '[' : '(';
    const closeBracket = isVector ? ']' : ')';
    
    // Check if server-side truncation occurred
    const originalCount = (arr as any)._originalCount as number | undefined;
    const totalItems = pagination?.totalCount || originalCount || arr.length;
    const isPaginated = pagination && pagination.totalCount > pagination.pageSize;
    
    const maxItems = config.maxListItems;
    const showEllipsis = !isPaginated && (arr.length > maxItems || (originalCount !== undefined && originalCount > arr.length));
    const itemsToShow = arr.length > maxItems ? arr.slice(0, maxItems) : arr;

    const items = itemsToShow.map(v => 
        `<span class="rf-list-item">${formatValueInner(v, config, depth + 1)}</span>`
    ).join(' ');

    // Show count info for large/truncated arrays
    let ellipsisText = '';
    if (showEllipsis) {
        ellipsisText = ` <span class="rf-list-ellipsis">.. (${totalItems.toLocaleString()} total)</span>`;
    }

    let paginationHtml = '';
    if (isPaginated) {
        paginationHtml = formatPaginationControls(pagination, 'list');
    }

    return `<span class="rf-list"><span class="rf-list-bracket">${openBracket}</span><span class="rf-list-items">${items}${ellipsisText}</span><span class="rf-list-bracket">${closeBracket}</span></span>${paginationHtml}`;
}

function formatError(error: RayforceError): string {
    const codeNames: { [key: number]: string } = {
        1: 'INIT', 2: 'PARSE', 3: 'EVAL', 4: 'FORMAT', 5: 'TYPE',
        6: 'LENGTH', 7: 'ARITY', 8: 'INDEX', 9: 'HEAP', 10: 'IO',
        11: 'SYS', 12: 'OS', 13: 'NOT_FOUND', 14: 'NOT_EXIST',
        15: 'NOT_IMPL', 16: 'NOT_SUPPORTED'
    };
    
    const codeName = codeNames[error.code] || `E${error.code}`;
    
    return `<span class="rf-error"><span class="rf-error-code">${codeName}</span>${escapeHtml(error.message)}</span>`;
}

function formatDictHtml(dict: RayforceDict, config: PrettyPrintConfig, depth: number): string {
    const keys = dict.keys;
    const values = dict.values;
    
    if (!Array.isArray(keys) || !Array.isArray(values)) {
        return `<span class="rf-dict"><span class="rf-dict-brace">{}</span></span>`;
    }

    if (keys.length === 0) {
        return `<span class="rf-dict"><span class="rf-dict-brace">{}</span></span>`;
    }

    const maxItems = config.maxListItems;
    const showEllipsis = keys.length > maxItems;
    const count = showEllipsis ? maxItems : keys.length;

    const entries: string[] = [];
    for (let i = 0; i < count; i++) {
        const key = formatValueInner(keys[i], config, depth + 1);
        const val = formatValueInner(values[i], config, depth + 1);
        entries.push(`<span class="rf-dict-entry"><span class="rf-dict-key">${key}</span><span class="rf-dict-colon">:</span>${val}</span>`);
    }

    return `<span class="rf-dict"><span class="rf-dict-brace">{</span>${entries.join(' ')}${showEllipsis ? ' <span class="rf-list-ellipsis">..</span>' : ''}<span class="rf-dict-brace">}</span></span>`;
}

// ============================================================================
// Pagination Controls
// ============================================================================

function formatPaginationControls(pagination: PaginationInfo, type: 'table' | 'list'): string {
    const { historyId, currentPage, pageSize, totalCount } = pagination;
    const totalPages = Math.ceil(totalCount / pageSize);
    const startRow = currentPage * pageSize + 1;
    const endRow = Math.min((currentPage + 1) * pageSize, totalCount);
    
    const prevDisabled = currentPage === 0;
    const nextDisabled = currentPage >= totalPages - 1;
    
    return `
        <div class="rf-pagination" data-history-id="${historyId}" data-type="${type}">
            <span class="rf-pagination-info">
                <strong>${startRow.toLocaleString()}</strong>–<strong>${endRow.toLocaleString()}</strong> of <strong>${totalCount.toLocaleString()}</strong>
            </span>
            <div class="rf-pagination-controls">
                <button class="rf-pagination-btn rf-pagination-first" ${currentPage === 0 ? 'disabled' : ''} title="First page">⟨⟨</button>
                <button class="rf-pagination-btn rf-pagination-prev" ${prevDisabled ? 'disabled' : ''} title="Previous page">⟨</button>
                <span class="rf-pagination-page">Page <strong>${currentPage + 1}</strong> of <strong>${totalPages}</strong></span>
                <button class="rf-pagination-btn rf-pagination-next" ${nextDisabled ? 'disabled' : ''} title="Next page">⟩</button>
                <button class="rf-pagination-btn rf-pagination-last" ${currentPage >= totalPages - 1 ? 'disabled' : ''} title="Last page">⟩⟩</button>
            </div>
            <div class="rf-pagination-size">
                <label>Show:</label>
                <select class="rf-pagination-select" data-history-id="${historyId}">
                    <option value="10" ${pageSize === 10 ? 'selected' : ''}>10</option>
                    <option value="25" ${pageSize === 25 ? 'selected' : ''}>25</option>
                    <option value="50" ${pageSize === 50 ? 'selected' : ''}>50</option>
                    <option value="100" ${pageSize === 100 ? 'selected' : ''}>100</option>
                    <option value="250" ${pageSize === 250 ? 'selected' : ''}>250</option>
                    <option value="500" ${pageSize === 500 ? 'selected' : ''}>500</option>
                </select>
            </div>
        </div>
    `;
}

// ============================================================================
// Table Formatter (The Beautiful One!)
// ============================================================================

export function formatTableHtml(table: RayforceTable, config: PrettyPrintConfig = DEFAULT_CONFIG, pagination?: PaginationInfo): string {
    const columns = table.columns;
    const values = table.values;

    if (columns.length === 0) {
        return `<span class="rf-table-inline">@table (empty)</span>`;
    }

    // Calculate dimensions
    const totalCols = columns.length;
    // Use the actual fetched row count
    const fetchedRows = Array.isArray(values) && values.length > 0 && Array.isArray(values[0]) 
        ? (values[0] as RayforceValue[]).length 
        : 0;
    
    // Check if server-side truncation occurred (set by executeCommand)
    const originalCount = (table as any)._originalCount as number | undefined;
    const totalRows = pagination?.totalCount || originalCount || fetchedRows;
    const isPaginated = pagination && pagination.totalCount > pagination.pageSize;

    const showCols = Math.min(totalCols, config.maxTableCols);
    const showRows = fetchedRows; // Show all fetched rows when paginated
    const truncatedCols = totalCols > showCols;

    // Use actual column types from table metadata, or detect from values
    const colTypes: string[] = [];
    for (let c = 0; c < showCols; c++) {
        if (table.columnTypes && table.columnTypes[c]) {
            colTypes.push(table.columnTypes[c]);
        } else {
            // Fallback: detect from first value
            const colData = values[c];
            if (Array.isArray(colData) && colData.length > 0) {
                colTypes.push(detectType(colData[0]));
            } else {
                colTypes.push('Unknown');
            }
        }
    }

    // Build HTML
    let html = `<div class="rf-table-container"><table class="rf-table">`;
    
    // Header row (column names)
    html += `<thead><tr>`;
    for (let c = 0; c < showCols; c++) {
        html += `<th>${escapeHtml(columns[c])}</th>`;
    }
    if (truncatedCols) {
        html += `<th>…</th>`;
    }
    html += `</tr>`;
    
    // Type row
    html += `<tr class="rf-table-type-row">`;
    for (let c = 0; c < showCols; c++) {
        html += `<th>${colTypes[c]}</th>`;
    }
    if (truncatedCols) {
        html += `<th></th>`;
    }
    html += `</tr></thead>`;

    // Data rows - show all when paginated
    html += `<tbody>`;
    
    for (let r = 0; r < showRows; r++) {
        html += `<tr>`;
        for (let c = 0; c < showCols; c++) {
            const colData = values[c];
            const cellValue = Array.isArray(colData) && r < colData.length ? colData[r] : null;
            html += `<td>${formatCellValue(cellValue, config)}</td>`;
        }
        if (truncatedCols) {
            html += `<td class="rf-list-ellipsis">…</td>`;
        }
        html += `</tr>`;
    }

    html += `</tbody></table>`;

    // Footer with stats and pagination controls
    html += `<div class="rf-table-footer">`;
    
    if (isPaginated) {
        // Pagination controls
        html += formatPaginationControls(pagination, 'table');
    } else {
        // Simple stats
        html += `<span class="rf-table-footer-stat"><strong>${totalRows.toLocaleString()}</strong> rows</span>`;
    }
    
    html += `<span class="rf-table-footer-stat"><strong>${totalCols}</strong> columns`;
    if (truncatedCols) {
        html += ` (${showCols} shown)`;
    }
    html += `</span>`;
    html += `</div></div>`;

    return html;
}

function formatCellValue(value: RayforceValue, config: PrettyPrintConfig): string {
    // Use a simplified config for cell values (shorter strings, etc.)
    const cellConfig: PrettyPrintConfig = {
        ...config,
        maxStringLength: 30,
        maxListItems: 5
    };
    return formatValueInner(value, cellConfig, 1);
}

// ============================================================================
// Plain Text Formatters (for copy/export)
// ============================================================================

export function formatValueText(value: RayforceValue, config: PrettyPrintConfig = DEFAULT_CONFIG): string {
    if (value === null) return '::';
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    if (typeof value === 'bigint') return value.toString();
    if (typeof value === 'number') {
        if (Number.isNaN(value)) return '0n';
        if (!Number.isFinite(value)) return value > 0 ? '0w' : '-0w';
        return Number.isInteger(value) ? value.toString() : value.toFixed(config.floatPrecision);
    }
    if (typeof value === 'string') return `"${value}"`;
    if (typeof value === 'symbol') return Symbol.keyFor(value) || '';
    if (value instanceof Date) {
        const pad = (n: number, len: number = 2) => n.toString().padStart(len, '0');
        return `${value.getFullYear()}.${pad(value.getMonth() + 1)}.${pad(value.getDate())}D${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}.${pad(value.getMilliseconds(), 3)}`;
    }
    if (Array.isArray(value)) {
        if (value.length === 0) return '()';
        const isVector = isHomogeneousArray(value);
        const items = value.map(v => formatValueText(v, config)).join(' ');
        return isVector ? `[${items}]` : `(${items})`;
    }
    if (typeof value === 'object' && '_type' in value) {
        if (value._type === 'error') return `'${(value as RayforceError).message}`;
        if (value._type === 'table') return formatTableText(value as RayforceTable, config);
        if (value._type === 'dict') {
            const dict = value as RayforceDict;
            return `${formatValueText(dict.keys, config)}!${formatValueText(dict.values, config)}`;
        }
    }
    return String(value);
}

export function formatTableText(table: RayforceTable, config: PrettyPrintConfig = DEFAULT_CONFIG): string {
    const columns = table.columns;
    const values = table.values;
    
    if (columns.length === 0) return '(empty table)';

    const totalRows = Array.isArray(values) && values.length > 0 && Array.isArray(values[0]) 
        ? (values[0] as RayforceValue[]).length 
        : 0;
    const showRows = Math.min(totalRows, config.maxTableRows);
    const showCols = Math.min(columns.length, config.maxTableCols);

    // Format all cells
    const cells: string[][] = [];
    for (let r = 0; r < showRows; r++) {
        const row: string[] = [];
        for (let c = 0; c < showCols; c++) {
            const colData = values[c];
            const cellValue = Array.isArray(colData) && r < colData.length ? colData[r] : null;
            row.push(formatValueText(cellValue, { ...config, maxStringLength: 30 }));
        }
        cells.push(row);
    }

    // Calculate column widths
    const colWidths: number[] = columns.slice(0, showCols).map((col, i) => {
        let maxW = col.length;
        for (const row of cells) {
            if (row[i]) maxW = Math.max(maxW, row[i].length);
        }
        return maxW;
    });

    // Build table with box chars
    const hLine = (left: string, mid: string, right: string) => {
        return left + colWidths.map(w => '─'.repeat(w + 2)).join(mid) + right;
    };

    const lines: string[] = [];
    
    // Top border
    lines.push(hLine('┌', '┬', '┐'));
    
    // Header
    lines.push('│ ' + columns.slice(0, showCols).map((col, i) => col.padEnd(colWidths[i])).join(' │ ') + ' │');
    
    // Header separator
    lines.push(hLine('├', '┼', '┤'));
    
    // Data rows
    for (const row of cells) {
        lines.push('│ ' + row.map((cell, i) => cell.padEnd(colWidths[i])).join(' │ ') + ' │');
    }

    // Footer separator
    lines.push(hLine('├', '┴', '┤'));
    
    // Footer
    const footer = ` ${totalRows} rows (${showRows} shown) ${columns.length} columns (${showCols} shown)`;
    const totalWidth = colWidths.reduce((a, b) => a + b, 0) + (colWidths.length - 1) * 3 + 2;
    lines.push('│' + footer.padEnd(totalWidth) + '│');
    
    // Bottom border
    lines.push('└' + '─'.repeat(totalWidth) + '┘');

    return lines.join('\n');
}

// ============================================================================
// Utilities
// ============================================================================

function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function isHomogeneousArray(arr: RayforceValue[]): boolean {
    if (arr.length === 0) return true;
    const firstType = detectType(arr[0]);
    // Lists are always heterogeneous in display
    if (firstType === 'List') return false;
    return arr.every(v => detectType(v) === firstType);
}

// ============================================================================
// Export defaults
// ============================================================================

export const defaultConfig = DEFAULT_CONFIG;

