import * as vscode from 'vscode';
import { RayforceIpcClient, isError, RayforceValue, RayforceDict, RayforceError } from './rayforceIpc';
import { formatValueHtml, formatValueText, getPrettyPrintStyles, detectType, defaultConfig, PaginationInfo } from './prettyPrint';

interface EnvEntry {
    name: string;
    type: string;
    value: string;
}

interface HistoryEntry {
    id: string;  // Unique ID for targeting pagination
    input: string;
    output: RayforceValue | string;  // Store raw value or string for system messages
    isError: boolean;
    isSystem: boolean;
    totalCount?: number;  // Original count for paginated data
    currentPage?: number;  // Current page (0-indexed)
    pageSize?: number;     // Items per page
}

export class RayforceReplPanel {
    public static currentPanel: RayforceReplPanel | undefined;
    private static readonly viewType = 'rayforceRepl';

    private readonly panel: vscode.WebviewPanel;
    private readonly extensionUri: vscode.Uri;
    private disposables: vscode.Disposable[] = [];

    private ipcClient: RayforceIpcClient | null = null;
    private host: string | null = null;
    private port: number | null = null;
    private history: HistoryEntry[] = [];
    private envData: EnvEntry[] = [];
    private showEnv: boolean = true;
    private envWidth: number = 280;
    private connectionVersion: number = 0;  // Track connection changes to abort stale operations
    private historyIdCounter: number = 0;  // For generating unique history entry IDs

    private generateHistoryId(): string {
        return `hist-${++this.historyIdCounter}`;
    }

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
        this.panel = panel;
        this.extensionUri = extensionUri;

        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
        this.panel.webview.onDidReceiveMessage(
            message => this.handleMessage(message),
            null,
            this.disposables
        );

        // Icon is set with light/dark variants, so VS Code handles theme changes automatically

        this.updateWebview();
    }


    public static createOrShow(extensionUri: vscode.Uri): RayforceReplPanel {
        const column = vscode.ViewColumn.Active;

        if (RayforceReplPanel.currentPanel) {
            RayforceReplPanel.currentPanel.panel.reveal(column);
            return RayforceReplPanel.currentPanel;
        }

        const panel = vscode.window.createWebviewPanel(
            RayforceReplPanel.viewType,
            'Rayforce REPL',
            column,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [extensionUri]
            }
        );

        // Set icon with light/dark variants - VS Code will automatically choose based on theme
        panel.iconPath = {
            light: vscode.Uri.joinPath(extensionUri, 'assets', 'icon-light.svg'),
            dark: vscode.Uri.joinPath(extensionUri, 'assets', 'icon-dark.svg')
        };

        RayforceReplPanel.currentPanel = new RayforceReplPanel(panel, extensionUri);
        return RayforceReplPanel.currentPanel;
    }

    public async connect(host: string, port: number): Promise<void> {
        // If already connected to same host:port, just reveal
        if (this.ipcClient && this.ipcClient.isConnected() && 
            this.host === host && this.port === port) {
            this.panel.reveal();
            return;
        }

        // Increment version to abort any pending operations
        this.connectionVersion++;
        const currentVersion = this.connectionVersion;

        // Disconnect existing client
        if (this.ipcClient) {
            const wasConnected = this.ipcClient.isConnected();
            this.ipcClient.disconnect();
            if (wasConnected && this.port !== port) {
                this.addSystemMessage(`Switching from ${this.host || 'localhost'}:${this.port}...`);
            }
        }

        // Create new client
        const newClient = new RayforceIpcClient(host, port);
        this.ipcClient = newClient;
        this.host = host;
        this.port = port;

        try {
            await newClient.connect(5000);

            // If connection changed while we were connecting, clean up this connection
            if (this.connectionVersion !== currentVersion) {
                newClient.disconnect();
                return;
            }

            this.addSystemMessage(`Connected to ${host}:${port}`);
            await this.refreshEnv();
        } catch (err) {
            // Clean up on error
            newClient.disconnect();
            
            // If connection changed while we were connecting, don't update state
            if (this.connectionVersion !== currentVersion) {
                return;
            }

            const message = err instanceof Error ? err.message : String(err);
            this.addSystemMessage(`Failed to connect: ${message}`, true);
            this.ipcClient = null;
            this.host = null;
            this.port = null;
            this.envData = [];
            this.updateWebview();
            throw err;
        }
    }

    public disconnect(): void {
        this.connectionVersion++;  // Abort any pending operations

        if (this.ipcClient) {
            this.ipcClient.disconnect();
            this.ipcClient = null;
            this.addSystemMessage('Disconnected');
            this.updateWebview();
        }
        this.host = null;
        this.port = null;
        this.envData = [];
    }

    public isConnected(): boolean {
        return this.ipcClient !== null && this.ipcClient.isConnected();
    }

    public getPort(): number | null {
        return this.port;
    }

    public getHost(): string | null {
        return this.host;
    }

    public async execute(command: string): Promise<void> {
        this.panel.reveal();
        await this.executeCommand(command);
        await this.refreshEnv();
    }

    private async handleMessage(message: any): Promise<void> {
        switch (message.command) {
            case 'execute':
                await this.executeCommand(message.text);
                await this.refreshEnv();
                break;
            case 'clear':
                this.history = [];
                this.updateWebview();
                break;
            case 'disconnect':
                this.disconnect();
                break;
            case 'refreshEnv':
                await this.refreshEnv();
                break;
            case 'toggleEnv':
                this.showEnv = !this.showEnv;
                this.updateWebview();
                break;
            case 'setEnvWidth':
                this.envWidth = message.width;
                break;
            case 'inspectVar':
                await this.inspectVariable(message.name);
                break;
            case 'changePage':
                await this.changeTablePage(message.historyId, message.page, message.pageSize);
                break;
            case 'changePageSize':
                await this.changeTablePageSize(message.historyId, message.pageSize);
                break;
        }
    }

    private async refreshEnv(): Promise<void> {
        const currentVersion = this.connectionVersion;

        if (!this.ipcClient) {
            this.envData = [];
            this.updateWebview();
            return;
        }
        
        if (!this.ipcClient.isConnected()) {
            this.envData = [];
            this.updateWebview();
            return;
        }

        try {
            // Batch request: get keys and types in just 2 IPC calls instead of N+1
            const keysResult = await this.ipcClient.execute('(key (env))');
            
            if (this.connectionVersion !== currentVersion) return;

            // Get all types in one call using (map type (value (env)))
            const typesResult = await this.ipcClient.execute('(map type (value (env)))');
            
            if (this.connectionVersion !== currentVersion) return;

            // Parse keys (list of symbols)
            const keys = this.parseEnvKeys(keysResult);
            
            // Parse types (list of symbols in same order as keys)
            const types = this.parseEnvTypes(typesResult);

            // Zip keys and types together
            const entries: EnvEntry[] = [];
            for (let i = 0; i < keys.length; i++) {
                entries.push({
                    name: keys[i],
                    type: types[i] || '?',
                    value: '' // Don't fetch value - only fetch on inspect
                });
            }

            this.envData = entries;
        } catch {
            if (this.connectionVersion !== currentVersion) return;
            this.envData = [];
        }

        this.updateWebview();
    }

    private parseEnvTypes(result: RayforceValue): string[] {
        const types: string[] = [];
        
        if (Array.isArray(result)) {
            for (const item of result) {
                if (typeof item === 'symbol') {
                    types.push(Symbol.keyFor(item) || String(item).replace('Symbol(', '').replace(')', ''));
                } else if (typeof item === 'string') {
                    types.push(item);
                } else {
                    types.push(String(item));
                }
            }
        }
        
        return types;
    }

    private parseEnvKeys(result: RayforceValue): string[] {
        const keys: string[] = [];
        
        if (Array.isArray(result)) {
            for (const item of result) {
                let name: string | null = null;
                if (typeof item === 'symbol') {
                    // Rayforce symbols are JavaScript Symbol primitives
                    name = Symbol.keyFor(item) || String(item);
                } else if (typeof item === 'string') {
                    name = item;
                }
                
                // Skip internal/system variables (starting with .)
                if (name && !name.startsWith('.')) {
                    keys.push(name);
                }
            }
        }
        
        // Sort alphabetically
        keys.sort((a, b) => a.localeCompare(b));
        
        return keys;
    }

    private parseTypeName(result: RayforceValue): string {
        if (typeof result === 'symbol') {
            return Symbol.keyFor(result) || String(result);
        }
        if (typeof result === 'string') {
            return result;
        }
        return String(result);
    }

    private formatShortValue(val: RayforceValue, maxLen: number = 30): string {
        const full = formatValueText(val, { ...defaultConfig, maxStringLength: maxLen });
        if (full.length <= maxLen) return full;
        return full.substring(0, maxLen - 3) + '...';
    }

    private async inspectVariable(name: string): Promise<void> {
        const currentVersion = this.connectionVersion;

        if (!this.ipcClient || !this.ipcClient.isConnected()) {
            return;
        }

        // Use same logic as executeCommand - try wrapper first, fall back to raw
        let useRawFallback = false;

        try {
            const wrappedCommand = this.wrapCommandForPreview(name);
            const result = await this.ipcClient.execute(wrappedCommand);

            if (this.connectionVersion !== currentVersion) return;

            // Check for wrapper parse errors
            if (isError(result) && (result as RayforceError).code === 2) {
                useRawFallback = true;
            } else if (!useRawFallback) {
                let actualResult: RayforceValue = result;
                let originalCount: number | null = null;

                if (Array.isArray(result) && result.length === 3) {
                    const [countVal, , dataVal] = result;
                    
                    if (typeof countVal === 'number') {
                        originalCount = countVal;
                    } else if (typeof countVal === 'bigint') {
                        originalCount = Number(countVal);
                    }
                    
                    actualResult = dataVal;
                    
                    if (originalCount !== null && originalCount > RayforceReplPanel.MAX_PREVIEW_ROWS) {
                        if (typeof actualResult === 'object' && actualResult !== null && '_type' in actualResult) {
                            if (actualResult._type === 'table') {
                                (actualResult as any)._originalCount = originalCount;
                            }
                        } else if (Array.isArray(actualResult)) {
                            (actualResult as any)._originalCount = originalCount;
                        }
                    }
                }

                const isPaginated = originalCount !== null && originalCount > RayforceReplPanel.MAX_PREVIEW_ROWS;
                this.history.push({
                    id: this.generateHistoryId(),
                    input: name,
                    output: actualResult,
                    isError: isError(actualResult),
                    isSystem: false,
                    totalCount: isPaginated && originalCount !== null ? originalCount : undefined,
                    currentPage: isPaginated ? 0 : undefined,
                    pageSize: isPaginated ? RayforceReplPanel.MAX_PREVIEW_ROWS : undefined
                });

                this.updateWebview();
                return;
            }
        } catch {
            useRawFallback = true;
        }

        // Fallback to raw execution
        if (useRawFallback) {
            try {
                const result = await this.ipcClient.execute(name);
                
                if (this.connectionVersion !== currentVersion) return;

                this.history.push({
                    id: this.generateHistoryId(),
                    input: name,
                    output: result,
                    isError: isError(result),
                    isSystem: false
                });

                this.updateWebview();
            } catch {
                // Ignore - connection likely changed
            }
        }
    }

    // Maximum rows to fetch for tables/lists to avoid huge data transfers
    // Keep this low for responsive UI - user can export full data if needed
    private static readonly MAX_PREVIEW_ROWS = 10;

    /**
     * Wrap a command to truncate large results server-side before IPC transfer.
     * Uses an anonymous function with let bindings (let only works inside fn).
     * Returns [original_count, type, truncated_result] as a list.
     */
    private wrapCommandForPreview(command: string): string {
        const maxRows = RayforceReplPanel.MAX_PREVIEW_ROWS;
        // Rayfall: (take collection [start count]) takes count items from start index
        return `((fn [] (let __pr_r ${command}) (let __pr_t (type __pr_r)) (let __pr_c (if (or (== __pr_t 'TABLE) (== __pr_t 'LIST)) (count __pr_r) 0)) (list __pr_c __pr_t (if (> __pr_c ${maxRows}) (take __pr_r [0 ${maxRows}]) __pr_r))))`;
    }

    /**
     * Wrap command to fetch a specific page of data.
     * Uses (take collection [start count]) to slice directly.
     */
    private wrapCommandForPage(command: string, offset: number, pageSize: number): string {
        // Rayfall: (take collection [start count]) takes count items from start index
        return `((fn [] (let __pr_r ${command}) (let __pr_t (type __pr_r)) (let __pr_c (if (or (== __pr_t 'TABLE) (== __pr_t 'LIST)) (count __pr_r) 0)) (list __pr_c __pr_t (take __pr_r [${offset} ${pageSize}]))))`;
    }

    /**
     * Navigate to a specific page for a paginated table result.
     */
    private async changeTablePage(historyId: string, page: number, pageSize: number): Promise<void> {
        const currentVersion = this.connectionVersion;
        const entry = this.history.find(h => h.id === historyId);
        
        if (!entry || !entry.input || entry.totalCount === undefined) return;
        if (!this.ipcClient || !this.ipcClient.isConnected()) return;

        const offset = page * pageSize;
        
        try {
            const wrappedCommand = this.wrapCommandForPage(entry.input, offset, pageSize);
            const result = await this.ipcClient.execute(wrappedCommand);
            
            if (this.connectionVersion !== currentVersion) return;
            
            if (isError(result)) return;
            
            // Parse wrapped result: [count, type, data]
            if (Array.isArray(result) && result.length === 3) {
                const [, , dataVal] = result;
                
                // Attach original count for display
                if (typeof dataVal === 'object' && dataVal !== null && '_type' in dataVal) {
                    if (dataVal._type === 'table') {
                        (dataVal as any)._originalCount = entry.totalCount;
                    }
                } else if (Array.isArray(dataVal)) {
                    (dataVal as any)._originalCount = entry.totalCount;
                }
                
                entry.output = dataVal;
                entry.currentPage = page;
                entry.pageSize = pageSize;
                this.updateWebview();
            }
        } catch {
            // Ignore pagination errors
        }
    }

    /**
     * Change the page size and reset to first page.
     */
    private async changeTablePageSize(historyId: string, pageSize: number): Promise<void> {
        const entry = this.history.find(h => h.id === historyId);
        if (!entry) return;
        
        entry.pageSize = pageSize;
        await this.changeTablePage(historyId, 0, pageSize);
    }

    private async executeCommand(input: string): Promise<void> {
        const currentVersion = this.connectionVersion;

        if (!input.trim()) return;

        if (!this.ipcClient || !this.ipcClient.isConnected()) {
            this.history.push({
                id: this.generateHistoryId(),
                input,
                output: 'Not connected to any Rayforce instance',
                isError: true,
                isSystem: false
            });
            this.updateWebview();
            return;
        }

        // First try the preview wrapper for potential large results
        let useRawFallback = false;
        
        try {
            const wrappedCommand = this.wrapCommandForPreview(input);
            const result = await this.ipcClient.execute(wrappedCommand);

            // Abort if connection changed
            if (this.connectionVersion !== currentVersion) return;

            // Check if the wrapper itself caused a parse error - fall back to raw
            if (isError(result)) {
                const errResult = result as RayforceError;
                // Parse errors (code 2) likely mean wrapper syntax issue - try raw
                if (errResult.code === 2) {
                    useRawFallback = true;
                } else {
                    // Other errors are from the user's command, show them
                    this.history.push({ id: this.generateHistoryId(), input, output: result, isError: true, isSystem: false });
                    this.updateWebview();
                    return;
                }
            }

            if (!useRawFallback) {
                // Parse the wrapped result: [original_count, type, truncated_result]
                let actualResult: RayforceValue = result;
                let originalCount: number | null = null;

                if (Array.isArray(result) && result.length === 3) {
                    const [countVal, , dataVal] = result;
                    
                    if (typeof countVal === 'number') {
                        originalCount = countVal;
                    } else if (typeof countVal === 'bigint') {
                        originalCount = Number(countVal);
                    }
                    
                    actualResult = dataVal;
                    
                    // Attach metadata for pretty printing
                    if (originalCount !== null && originalCount > RayforceReplPanel.MAX_PREVIEW_ROWS) {
                        if (typeof actualResult === 'object' && actualResult !== null && '_type' in actualResult) {
                            if (actualResult._type === 'table') {
                                (actualResult as any)._originalCount = originalCount;
                            }
                        } else if (Array.isArray(actualResult)) {
                            (actualResult as any)._originalCount = originalCount;
                        }
                    }
                }

                const isPaginated = originalCount !== null && originalCount > RayforceReplPanel.MAX_PREVIEW_ROWS;
                this.history.push({
                    id: this.generateHistoryId(),
                    input,
                    output: actualResult,
                    isError: isError(actualResult),
                    isSystem: false,
                    totalCount: isPaginated && originalCount !== null ? originalCount : undefined,
                    currentPage: isPaginated ? 0 : undefined,
                    pageSize: isPaginated ? RayforceReplPanel.MAX_PREVIEW_ROWS : undefined
                });
                this.updateWebview();
                return;
            }
        } catch {
            useRawFallback = true;
        }

        // Fallback: execute raw command (may be slow for large results)
        if (useRawFallback) {
            if (this.connectionVersion !== currentVersion) return;
            
            try {
                const result = await this.ipcClient.execute(input);
                
                if (this.connectionVersion !== currentVersion) return;

                this.history.push({
                    id: this.generateHistoryId(),
                    input,
                    output: result,
                    isError: isError(result),
                    isSystem: false
                });
            } catch (rawErr) {
                if (this.connectionVersion !== currentVersion) return;

                this.history.push({
                    id: this.generateHistoryId(),
                    input,
                    output: rawErr instanceof Error ? rawErr.message : String(rawErr),
                    isError: true,
                    isSystem: false
                });
            }
            
            this.updateWebview();
        }
    }

    private addSystemMessage(message: string, isError: boolean = false): void {
        this.history.push({ id: this.generateHistoryId(), input: '', output: message, isError, isSystem: true });
        this.updateWebview();
    }

    private updateWebview(): void {
        this.panel.webview.html = this.getHtmlContent();
        this.panel.title = this.port
            ? `Rayforce REPL — localhost:${this.port}`
            : 'Rayforce REPL — Disconnected';
    }

    private getHtmlContent(): string {
        const isConnected = this.isConnected();
        const logoBlackUri = this.panel.webview.asWebviewUri(
            vscode.Uri.joinPath(this.extensionUri, 'assets', 'logo_black.svg')
        );
        const logoWhiteUri = this.panel.webview.asWebviewUri(
            vscode.Uri.joinPath(this.extensionUri, 'assets', 'logo_white.svg')
        );

        const historyHtml = this.history.map(item => {
            if (item.isSystem) {
                // System message - render as plain text
                return `
                    <div class="history-item system">
                        <div class="output-line ${item.isError ? 'error' : 'info'}">[System] ${this.escapeHtml(String(item.output))}</div>
                    </div>
                `;
            } else if (item.input) {
                // Build pagination info if available
                let pagination: PaginationInfo | undefined;
                if (item.totalCount !== undefined && item.currentPage !== undefined && item.pageSize !== undefined) {
                    pagination = {
                        historyId: item.id,
                        currentPage: item.currentPage,
                        pageSize: item.pageSize,
                        totalCount: item.totalCount
                    };
                }
                
                // User command with output - render with pretty print
                const outputHtml = typeof item.output === 'string'
                    ? `<span class="rf-error">${this.escapeHtml(item.output)}</span>`
                    : formatValueHtml(item.output as RayforceValue, defaultConfig, pagination);
                return `
                    <div class="history-item">
                        <div class="input-line"><span class="prompt-char">&gt;</span> <span class="input-text">${this.highlightSyntax(item.input)}</span></div>
                        <div class="output-line ${item.isError ? 'error-output' : ''}">${outputHtml}</div>
                    </div>
                `;
            } else {
                return '';
            }
        }).join('');

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Rayforce REPL</title>
    <style>
        ${getPrettyPrintStyles()}
        
        :root {
            /* Use VSCode native theme colors */
            --bg-primary: var(--vscode-editor-background);
            --bg-secondary: var(--vscode-sideBar-background);
            --bg-input: var(--vscode-input-background);
            --text-primary: var(--vscode-editor-foreground);
            --text-secondary: var(--vscode-descriptionForeground);
            --accent: var(--vscode-textLink-foreground);
            --accent-dim: var(--vscode-textLink-activeForeground);
            --error: var(--vscode-errorForeground);
            --info: var(--vscode-textLink-foreground);
            --border: var(--vscode-panel-border, var(--vscode-widget-border));
            --button-bg: var(--vscode-button-background);
            --button-fg: var(--vscode-button-foreground);
            --button-hover: var(--vscode-button-hoverBackground);
            --input-border: var(--vscode-input-border);
            --focus-border: var(--vscode-focusBorder);
            --badge-bg: var(--vscode-badge-background);
            --badge-fg: var(--vscode-badge-foreground);
        }

        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        html, body {
            width: 100%;
            height: 100%;
            overflow: hidden;
            padding: 0 !important;
            margin: 0 !important;
        }

        body {
            font-family: var(--vscode-editor-font-family, 'SF Mono', Consolas, monospace);
            font-size: var(--vscode-editor-font-size, 13px);
            line-height: 1.6;
            background: var(--bg-primary);
            color: var(--text-primary);
            display: flex;
            flex-direction: row;
        }

        .main-panel {
            flex: 1;
            display: flex;
            flex-direction: column;
            min-width: 0;
            width: 100%;
        }

        .header {
            padding: 12px 16px;
            background: var(--bg-secondary);
            border-bottom: 1px solid var(--border);
            display: flex;
            justify-content: space-between;
            align-items: center;
            width: 100%;
        }

        .env-panel {
            width: ${this.showEnv ? `${this.envWidth}px` : '0'};
            min-width: ${this.showEnv ? '150px' : '0'};
            max-width: ${this.showEnv ? '500px' : '0'};
            background: var(--bg-secondary);
            border-left: 1px solid var(--border);
            display: flex;
            flex-direction: column;
            overflow: hidden;
            position: relative;
        }

        .env-resize-handle {
            position: absolute;
            left: 0;
            top: 0;
            bottom: 0;
            width: 4px;
            cursor: ew-resize;
            background: transparent;
            z-index: 10;
        }

        .env-resize-handle:hover,
        .env-resize-handle.dragging {
            background: var(--accent);
        }

        .env-header {
            padding: 12px 16px;
            border-bottom: 1px solid var(--border);
            display: flex;
            justify-content: space-between;
            align-items: center;
        }

        .env-title {
            font-size: 11px;
            font-weight: 600;
            text-transform: uppercase;
            color: var(--text-secondary);
            letter-spacing: 0.5px;
        }

        .env-actions {
            display: flex;
            gap: 4px;
        }

        .env-btn {
            background: transparent;
            border: 1px solid var(--border);
            color: var(--text-secondary);
            cursor: pointer;
            padding: 6px 10px;
            border-radius: 4px;
            font-size: 14px;
            transition: all 0.15s;
        }

        .env-btn:hover {
            color: var(--accent);
            background: var(--bg-input);
            border-color: var(--accent);
        }

        .env-content {
            flex: 1;
            overflow-y: auto;
            padding: 8px 0;
        }

        .env-item {
            padding: 6px 16px;
            cursor: pointer;
            display: flex;
            align-items: center;
            gap: 8px;
            transition: background 0.15s;
        }

        .env-item:hover {
            background: var(--bg-input);
        }

        .env-item-name {
            color: var(--accent);
            flex: 1;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }

        .env-item-type {
            font-size: 10px;
            color: var(--badge-fg);
            background: var(--badge-bg);
            padding: 2px 6px;
            border-radius: 3px;
        }

        .env-item-value {
            font-size: 11px;
            color: var(--text-secondary);
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            max-width: 100px;
        }

        .env-empty {
            padding: 24px 16px;
            text-align: center;
            color: var(--text-secondary);
            font-size: 12px;
        }

        .status {
            display: flex;
            align-items: center;
            gap: 8px;
        }

        .status-indicator {
            width: 8px;
            height: 8px;
            border-radius: 50%;
            background: ${isConnected ? 'var(--vscode-testing-iconPassed, #4caf50)' : 'var(--vscode-testing-iconFailed, #f44336)'};
        }

        .status-text {
            color: var(--text-secondary);
            font-size: 12px;
        }

        .header-actions {
            display: flex;
            gap: 8px;
        }

        .header-btn {
            background: transparent;
            border: 1px solid var(--border);
            color: var(--text-secondary);
            padding: 4px 12px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 11px;
            font-family: inherit;
            transition: all 0.2s;
        }

        .header-btn:hover {
            border-color: var(--accent);
            color: var(--accent);
        }

        .header-btn.active {
            border-color: var(--accent);
            color: var(--accent);
            background: var(--vscode-toolbar-activeBackground, rgba(128, 128, 128, 0.1));
        }

        .history {
            flex: 1;
            overflow-y: auto;
            padding: 16px;
        }

        .history-item {
            margin-bottom: 16px;
        }

        .history-item.system {
            margin-bottom: 8px;
        }

        .input-line {
            color: var(--text-primary);
            margin-bottom: 4px;
        }

        .input-text {
            /* Syntax highlighting colors are applied via span classes */
        }

        .output-line {
            color: var(--text-secondary);
            white-space: pre-wrap;
            word-break: break-word;
            padding-left: 20px;
        }

        .output-line.error {
            color: var(--error);
        }

        .output-line.error-output .rf-error {
            color: var(--error);
        }

        .output-line.info {
            color: var(--info);
            font-style: italic;
            padding-left: 0;
        }

        /* Override table container margin for REPL */
        .output-line .rf-table-container {
            margin: 8px 0 8px 0;
        }

        .input-area {
            padding: 12px 16px;
            background: var(--bg-secondary);
            border-top: 1px solid var(--border);
            width: 100%;
        }

        .input-wrapper {
            display: flex;
            align-items: center;
            background: var(--bg-input);
            border: 1px solid var(--border);
            border-radius: 6px;
            padding: 8px 12px;
            transition: border-color 0.2s;
        }

        .input-wrapper:focus-within {
            border-color: var(--focus-border);
        }

        .input-container {
            flex: 1;
            position: relative;
            overflow: hidden;
            display: flex;
            align-items: center;
        }

        #command-input {
            width: 100%;
            background: transparent;
            border: none;
            color: transparent;
            caret-color: var(--text-primary);
            font-family: inherit;
            font-size: 13px;
            outline: none;
            position: relative;
            z-index: 2;
            padding: 0;
            margin: 0;
            line-height: 1.4;
        }

        #command-input::placeholder {
            color: var(--text-secondary);
            opacity: 0.7;
        }

        #syntax-highlight {
            position: absolute;
            top: 50%;
            left: 0;
            transform: translateY(-50%);
            font-family: inherit;
            font-size: 13px;
            line-height: 1.4;
            white-space: pre;
            pointer-events: none;
            z-index: 1;
            overflow: hidden;
            padding: 0;
            margin: 0;
        }

        /* Syntax highlighting colors - DuckDB style */
        .syn-comment { color: var(--vscode-terminal-ansiBrightBlack, #6a737d); font-style: italic; }
        .syn-string { color: var(--vscode-terminal-ansiYellow, #e5c07b); }
        .syn-number { color: var(--vscode-terminal-ansiYellow, #e5c07b); }
        .syn-keyword { color: var(--vscode-terminal-ansiGreen, #98c379); font-weight: 500; }
        .syn-function { color: var(--vscode-terminal-ansiCyan, #56b6c2); }
        .syn-core-fn { color: var(--vscode-terminal-ansiCyan, #56b6c2); }
        .syn-symbol { color: var(--vscode-terminal-ansiMagenta, #c678dd); }
        .syn-type { color: var(--vscode-terminal-ansiBlue, #61afef); }
        .syn-constant { color: var(--vscode-terminal-ansiYellow, #e5c07b); }
        .syn-operator { color: var(--text-primary); }
        .syn-paren { color: var(--text-secondary); }
        .syn-bracket { color: var(--text-secondary); }
        .syn-brace { color: var(--text-secondary); }
        .syn-special-var { color: var(--vscode-terminal-ansiRed, #e06c75); font-style: italic; }

        .submit-btn {
            background: var(--button-bg);
            color: var(--button-fg);
            border: none;
            padding: 6px 16px;
            border-radius: 4px;
            cursor: pointer;
            font-family: inherit;
            font-size: 12px;
            font-weight: 600;
            margin-left: 8px;
            transition: all 0.2s;
        }

        .submit-btn:hover {
            background: var(--button-hover);
        }

        .submit-btn:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }

        .empty-state {
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            height: 100%;
            color: var(--text-secondary);
        }

        .empty-state-logo {
            width: 64px;
            height: 64px;
            margin-bottom: 16px;
            opacity: 0.6;
        }

        .logo-light { display: none; }
        .logo-dark { display: block; }
        
        body.vscode-light .logo-light { display: block; }
        body.vscode-light .logo-dark { display: none; }

        .empty-state-text {
            font-size: 14px;
        }

        .prompt-char {
            color: var(--vscode-terminal-ansiGreen, #4ec9b0);
            font-weight: 600;
            margin-right: 6px;
        }

        .input-prompt-char {
            color: var(--vscode-terminal-ansiGreen, #4ec9b0);
            font-weight: 600;
            font-size: 14px;
            margin-right: 8px;
        }

        .shortcuts {
            margin-top: 24px;
            font-size: 11px;
            color: var(--text-secondary);
            opacity: 0.7;
        }

        .shortcuts kbd {
            background: var(--bg-secondary);
            padding: 2px 6px;
            border-radius: 3px;
            border: 1px solid var(--border);
        }

        ::-webkit-scrollbar {
            width: 8px;
        }

        ::-webkit-scrollbar-track {
            background: var(--bg-primary);
        }

        ::-webkit-scrollbar-thumb {
            background: var(--border);
            border-radius: 4px;
        }

        ::-webkit-scrollbar-thumb:hover {
            background: var(--text-secondary);
        }

        /* Autocomplete dropdown */
        .autocomplete-container {
            position: relative;
        }

        .autocomplete-dropdown {
            position: absolute;
            bottom: 100%;
            left: 0;
            right: 0;
            max-height: 200px;
            overflow-y: auto;
            background: var(--vscode-editorWidget-background, var(--bg-secondary));
            border: 1px solid var(--vscode-editorWidget-border, var(--border));
            border-radius: 4px;
            box-shadow: 0 -4px 12px rgba(0, 0, 0, 0.2);
            z-index: 1000;
            display: none;
            margin-bottom: 4px;
        }

        .autocomplete-dropdown.visible {
            display: block;
        }

        .autocomplete-item {
            padding: 6px 12px;
            cursor: pointer;
            display: flex;
            align-items: center;
            gap: 8px;
            font-size: 13px;
        }

        .autocomplete-item:hover,
        .autocomplete-item.selected {
            background: var(--vscode-list-hoverBackground, rgba(128, 128, 128, 0.1));
        }

        .autocomplete-item.selected {
            background: var(--vscode-list-activeSelectionBackground, var(--accent));
            color: var(--vscode-list-activeSelectionForeground, white);
        }

        .autocomplete-item-name {
            font-family: var(--vscode-editor-font-family, monospace);
            font-weight: 500;
        }

        .autocomplete-item-kind {
            font-size: 10px;
            padding: 1px 5px;
            border-radius: 3px;
            background: var(--badge-bg);
            color: var(--badge-fg);
            text-transform: uppercase;
        }

        .autocomplete-item-detail {
            color: var(--text-secondary);
            font-size: 11px;
            margin-left: auto;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }

        .autocomplete-item.selected .autocomplete-item-detail {
            color: var(--vscode-list-activeSelectionForeground, rgba(255, 255, 255, 0.7));
        }
    </style>
</head>
<body>
    <div class="main-panel">
        <div class="header">
            <div class="status">
                <div class="status-indicator"></div>
                <span class="status-text">${isConnected ? `localhost:${this.port}` : 'Disconnected'}</span>
            </div>
            <div class="header-actions">
                <button class="header-btn ${this.showEnv ? 'active' : ''}" onclick="toggleEnv()" title="Toggle Environment Panel">
                    ${this.showEnv ? '▶ Env' : 'Env ◀'}
                </button>
                <button class="header-btn" onclick="clearHistory()">Clear</button>
                ${isConnected ? '<button class="header-btn" onclick="disconnect()">Disconnect</button>' : ''}
            </div>
        </div>

        <div class="history" id="history">
            ${this.history.length === 0 ? `
                <div class="empty-state">
                    <img src="${logoWhiteUri}" class="empty-state-logo logo-dark" alt="Rayforce" />
                    <img src="${logoBlackUri}" class="empty-state-logo logo-light" alt="Rayforce" />
                    <div class="empty-state-text">
                        ${isConnected
                    ? 'Ready to execute Rayforce commands'
                    : 'Connect to a Rayforce instance to start'}
                    </div>
                    
                </div>
            ` : historyHtml}
        </div>

        <div class="input-area">
            <div class="autocomplete-container">
                <div class="autocomplete-dropdown" id="autocomplete-dropdown"></div>
                <div class="input-wrapper">
                    <span class="input-prompt-char">&gt;</span>
                    <div class="input-container">
                        <div id="syntax-highlight"></div>
                        <input 
                            type="text" 
                            id="command-input" 
                            placeholder="${isConnected ? 'Enter Rayfall expression...' : 'Not connected'}"
                            ${isConnected ? '' : 'disabled'}
                            autocomplete="off"
                            spellcheck="false"
                        />
                    </div>
                    <button class="submit-btn" onclick="executeCommand()" ${isConnected ? '' : 'disabled'}>
                        Run
                    </button>
                </div>
            </div>
        </div>
    </div>

    ${this.showEnv ? `
    <div class="env-panel" id="env-panel">
        <div class="env-resize-handle" id="env-resize-handle"></div>
        <div class="env-header">
            <span class="env-title">Environment</span>
            <div class="env-actions">
                <button class="env-btn" onclick="refreshEnv()" title="Refresh">⟳</button>
            </div>
        </div>
        <div class="env-content">
            ${this.envData.length === 0
                    ? `<div class="env-empty">${isConnected ? 'No variables defined' : 'Not connected'}</div>`
                    : this.envData.map(entry => `
                    <div class="env-item" onclick="inspectVar('${entry.name.replace(/'/g, "\\'")}')" title="${this.escapeHtml(entry.value)}">
                        <span class="env-item-name">${this.escapeHtml(entry.name)}</span>
                        <span class="env-item-type">${entry.type}</span>
                    </div>
                `).join('')
                }
        </div>
    </div>
    ` : ''}

    <script>
        const vscode = acquireVsCodeApi();
        const input = document.getElementById('command-input');
        const history = document.getElementById('history');
        const syntaxHighlight = document.getElementById('syntax-highlight');
        const autocompleteDropdown = document.getElementById('autocomplete-dropdown');
        
        const state = vscode.getState() || { commandHistory: [], historyIndex: -1, inputValue: '' };
        let commandHistory = state.commandHistory;
        let historyIndex = state.historyIndex;
        
        // Autocomplete data
        const AUTOCOMPLETE_DATA = [
            // Keywords
            { name: 'fn', kind: 'keyword', detail: 'Define anonymous function' },
            { name: 'do', kind: 'keyword', detail: 'Execute multiple expressions' },
            { name: 'set', kind: 'keyword', detail: 'Bind value to symbol' },
            { name: 'let', kind: 'keyword', detail: 'Local binding' },
            { name: 'if', kind: 'keyword', detail: 'Conditional expression' },
            { name: 'and', kind: 'keyword', detail: 'Logical AND' },
            { name: 'or', kind: 'keyword', detail: 'Logical OR' },
            { name: 'try', kind: 'keyword', detail: 'Try-catch expression' },
            { name: 'quote', kind: 'keyword', detail: 'Quote expression' },
            { name: 'self', kind: 'keyword', detail: 'Self-reference in recursive fn' },
            { name: 'timeit', kind: 'keyword', detail: 'Measure execution time' },
            // Unary functions
            { name: 'get', kind: 'fn', detail: 'Get value' },
            { name: 'raise', kind: 'fn', detail: 'Raise an error' },
            { name: 'read', kind: 'fn', detail: 'Read from file' },
            { name: 'parse', kind: 'fn', detail: 'Parse string' },
            { name: 'eval', kind: 'fn', detail: 'Evaluate expression' },
            { name: 'load', kind: 'fn', detail: 'Load file' },
            { name: 'type', kind: 'fn', detail: 'Get type' },
            { name: 'til', kind: 'fn', detail: 'Range 0..n-1' },
            { name: 'reverse', kind: 'fn', detail: 'Reverse list' },
            { name: 'distinct', kind: 'fn', detail: 'Unique values' },
            { name: 'group', kind: 'fn', detail: 'Group by values' },
            { name: 'sum', kind: 'fn', detail: 'Sum values' },
            { name: 'avg', kind: 'fn', detail: 'Average' },
            { name: 'med', kind: 'fn', detail: 'Median' },
            { name: 'dev', kind: 'fn', detail: 'Std deviation' },
            { name: 'min', kind: 'fn', detail: 'Minimum' },
            { name: 'max', kind: 'fn', detail: 'Maximum' },
            { name: 'round', kind: 'fn', detail: 'Round number' },
            { name: 'floor', kind: 'fn', detail: 'Round down' },
            { name: 'ceil', kind: 'fn', detail: 'Round up' },
            { name: 'first', kind: 'fn', detail: 'First element' },
            { name: 'last', kind: 'fn', detail: 'Last element' },
            { name: 'count', kind: 'fn', detail: 'Count elements' },
            { name: 'not', kind: 'fn', detail: 'Logical NOT' },
            { name: 'iasc', kind: 'fn', detail: 'Indices ascending' },
            { name: 'idesc', kind: 'fn', detail: 'Indices descending' },
            { name: 'rank', kind: 'fn', detail: 'Rank values' },
            { name: 'asc', kind: 'fn', detail: 'Sort ascending' },
            { name: 'desc', kind: 'fn', detail: 'Sort descending' },
            { name: 'guid', kind: 'fn', detail: 'Generate GUID' },
            { name: 'neg', kind: 'fn', detail: 'Negate' },
            { name: 'where', kind: 'fn', detail: 'Indices where true' },
            { name: 'key', kind: 'fn', detail: 'Get keys' },
            { name: 'value', kind: 'fn', detail: 'Get values' },
            { name: 'ser', kind: 'fn', detail: 'Serialize' },
            { name: 'de', kind: 'fn', detail: 'Deserialize' },
            { name: 'hclose', kind: 'fn', detail: 'Close handle' },
            { name: 'select', kind: 'fn', detail: 'Query table' },
            { name: 'update', kind: 'fn', detail: 'Update table' },
            { name: 'date', kind: 'fn', detail: 'Convert to date' },
            { name: 'time', kind: 'fn', detail: 'Convert to time' },
            { name: 'timestamp', kind: 'fn', detail: 'Convert to timestamp' },
            { name: 'nil?', kind: 'fn', detail: 'Check if null' },
            { name: 'resolve', kind: 'fn', detail: 'Resolve symbol' },
            { name: 'show', kind: 'fn', detail: 'Display value' },
            { name: 'meta', kind: 'fn', detail: 'Get metadata' },
            { name: 'system', kind: 'fn', detail: 'System command' },
            { name: 'raze', kind: 'fn', detail: 'Flatten list' },
            { name: 'unify', kind: 'fn', detail: 'Unify types' },
            { name: 'diverse', kind: 'fn', detail: 'Check diverse' },
            { name: 'row', kind: 'fn', detail: 'Get table row' },
            // Binary functions
            { name: 'write', kind: 'fn', detail: 'Write to file' },
            { name: 'at', kind: 'fn', detail: 'Index into' },
            { name: 'div', kind: 'fn', detail: 'Integer division' },
            { name: 'like', kind: 'fn', detail: 'Pattern match' },
            { name: 'dict', kind: 'fn', detail: 'Create dictionary' },
            { name: 'table', kind: 'fn', detail: 'Create table' },
            { name: 'find', kind: 'fn', detail: 'Find index' },
            { name: 'concat', kind: 'fn', detail: 'Concatenate' },
            { name: 'remove', kind: 'fn', detail: 'Remove elements' },
            { name: 'filter', kind: 'fn', detail: 'Filter collection' },
            { name: 'take', kind: 'fn', detail: 'Take n elements' },
            { name: 'in', kind: 'fn', detail: 'Membership test' },
            { name: 'within', kind: 'fn', detail: 'Range test' },
            { name: 'sect', kind: 'fn', detail: 'Intersection' },
            { name: 'except', kind: 'fn', detail: 'Set difference' },
            { name: 'union', kind: 'fn', detail: 'Set union' },
            { name: 'rand', kind: 'fn', detail: 'Random values' },
            { name: 'as', kind: 'fn', detail: 'Cast to type' },
            { name: 'xasc', kind: 'fn', detail: 'Sort table asc' },
            { name: 'xdesc', kind: 'fn', detail: 'Sort table desc' },
            { name: 'xrank', kind: 'fn', detail: 'Rank groups' },
            { name: 'enum', kind: 'fn', detail: 'Create enum' },
            { name: 'xbar', kind: 'fn', detail: 'Bar/bucket' },
            { name: 'split', kind: 'fn', detail: 'Split string' },
            { name: 'bin', kind: 'fn', detail: 'Binary search' },
            { name: 'binr', kind: 'fn', detail: 'Binary search right' },
            // Variadic functions
            { name: 'env', kind: 'fn', detail: 'Get environment' },
            { name: 'memstat', kind: 'fn', detail: 'Memory stats' },
            { name: 'gc', kind: 'fn', detail: 'Garbage collect' },
            { name: 'list', kind: 'fn', detail: 'Create list' },
            { name: 'enlist', kind: 'fn', detail: 'Enlist value' },
            { name: 'format', kind: 'fn', detail: 'Format string' },
            { name: 'print', kind: 'fn', detail: 'Print' },
            { name: 'println', kind: 'fn', detail: 'Print line' },
            { name: 'apply', kind: 'fn', detail: 'Apply function' },
            { name: 'map', kind: 'fn', detail: 'Map over collection' },
            { name: 'pmap', kind: 'fn', detail: 'Parallel map' },
            { name: 'map-left', kind: 'fn', detail: 'Map fixed left' },
            { name: 'map-right', kind: 'fn', detail: 'Map fixed right' },
            { name: 'fold', kind: 'fn', detail: 'Reduce/fold' },
            { name: 'fold-left', kind: 'fn', detail: 'Left fold' },
            { name: 'fold-right', kind: 'fn', detail: 'Right fold' },
            { name: 'scan', kind: 'fn', detail: 'Running fold' },
            { name: 'scan-left', kind: 'fn', detail: 'Left scan' },
            { name: 'scan-right', kind: 'fn', detail: 'Right scan' },
            { name: 'args', kind: 'fn', detail: 'CLI arguments' },
            { name: 'alter', kind: 'fn', detail: 'Alter in-place' },
            { name: 'modify', kind: 'fn', detail: 'Modify value' },
            { name: 'insert', kind: 'fn', detail: 'Insert row' },
            { name: 'upsert', kind: 'fn', detail: 'Upsert row' },
            { name: 'read-csv', kind: 'fn', detail: 'Read CSV' },
            { name: 'write-csv', kind: 'fn', detail: 'Write CSV' },
            { name: 'left-join', kind: 'fn', detail: 'Left join' },
            { name: 'inner-join', kind: 'fn', detail: 'Inner join' },
            { name: 'asof-join', kind: 'fn', detail: 'As-of join' },
            { name: 'window-join', kind: 'fn', detail: 'Window join' },
            { name: 'return', kind: 'fn', detail: 'Return value' },
            { name: 'hopen', kind: 'fn', detail: 'Open handle' },
            { name: 'exit', kind: 'fn', detail: 'Exit runtime' },
            { name: 'loadfn', kind: 'fn', detail: 'Load function' },
            { name: 'timer', kind: 'fn', detail: 'Set timer' },
            { name: 'set-splayed', kind: 'fn', detail: 'Save splayed' },
            { name: 'get-splayed', kind: 'fn', detail: 'Load splayed' },
            { name: 'set-parted', kind: 'fn', detail: 'Save partitioned' },
            { name: 'get-parted', kind: 'fn', detail: 'Load partitioned' },
            { name: 'internals', kind: 'fn', detail: 'Internal values' },
            { name: 'sysinfo', kind: 'fn', detail: 'System info' },
            // Types
            { name: 'B8', kind: 'type', detail: 'Boolean' },
            { name: 'U8', kind: 'type', detail: 'Unsigned 8-bit' },
            { name: 'I16', kind: 'type', detail: '16-bit integer' },
            { name: 'I32', kind: 'type', detail: '32-bit integer' },
            { name: 'I64', kind: 'type', detail: '64-bit integer' },
            { name: 'F64', kind: 'type', detail: '64-bit float' },
            { name: 'C8', kind: 'type', detail: 'Character' },
            { name: 'SYMBOL', kind: 'type', detail: 'Symbol' },
            { name: 'DATE', kind: 'type', detail: 'Date' },
            { name: 'TIME', kind: 'type', detail: 'Time' },
            { name: 'TIMESTAMP', kind: 'type', detail: 'Timestamp' },
            { name: 'GUID', kind: 'type', detail: 'GUID' },
            { name: 'LIST', kind: 'type', detail: 'List' },
            { name: 'TABLE', kind: 'type', detail: 'Table' },
            { name: 'DICT', kind: 'type', detail: 'Dictionary' },
            // Query keywords
            { name: 'from:', kind: 'keyword', detail: 'Source table' },
            { name: 'where:', kind: 'keyword', detail: 'Filter condition' },
            { name: 'by:', kind: 'keyword', detail: 'Group by' },
            { name: 'take:', kind: 'keyword', detail: 'Limit rows' },
            // Constants
            { name: 'nil', kind: 'const', detail: 'Null value' },
            { name: 'true', kind: 'const', detail: 'Boolean true' },
            { name: 'false', kind: 'const', detail: 'Boolean false' },
        ];

        let autocompleteVisible = false;
        let autocompleteItems = [];
        let autocompleteSelectedIndex = 0;
        let currentPrefix = '';
        let prefixStart = 0;
        
        if (input && state.inputValue) {
            input.value = state.inputValue;
            updateHighlight();
        }

        history.scrollTop = history.scrollHeight;

        // Rayfall syntax highlighting
        const KEYWORDS = new Set(['fn', 'do', 'let', 'if', 'cond', 'when', 'unless', 'set', 'try', 'catch', 'return', 'exit', 'raise', 'throw', 'quote', 'and', 'or', 'def', 'defn', 'loop', 'recur']);
        const QUERY_KW = new Set(['select', 'update', 'delete', 'insert', 'upsert', 'alter', 'modify', 'from', 'where', 'by', 'take', 'into', 'as']);
        const CORE_FNS = new Set(['list', 'enlist', 'table', 'dict', 'first', 'last', 'count', 'reverse', 'distinct', 'raze', 'concat', 'remove', 'filter', 'til', 'drop', 'row', 'key', 'value', 'keys', 'values', 'flip', 'get', 'at', 'in', 'within', 'sect', 'except', 'union', 'find', 'group', 'ungroup', 'enum', 'xbar', 'split', 'bin', 'binr', 'sum', 'avg', 'med', 'dev', 'var', 'min', 'max', 'all', 'any', 'prod', 'wavg', 'wsum', 'cov', 'cor', 'sums', 'prds', 'mins', 'maxs', 'avgs', 'msum', 'mcount', 'mavg', 'mmin', 'mmax', 'abs', 'neg', 'floor', 'ceil', 'round', 'sqrt', 'exp', 'log', 'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'signum', 'mod', 'div', 'reciprocal', 'asc', 'desc', 'iasc', 'idesc', 'rank', 'xasc', 'xdesc', 'xrank', 'sort', 'apply', 'map', 'pmap', 'fold', 'scan', 'map-left', 'map-right', 'fold-left', 'fold-right', 'scan-left', 'scan-right', 'each', 'peach', 'over', 'converge', 'left-join', 'inner-join', 'asof-join', 'window-join', 'lj', 'ij', 'aj', 'wj', 'uj', 'pj', 'read', 'write', 'read-csv', 'write-csv', 'hopen', 'hclose', 'load', 'save', 'set-splayed', 'get-splayed', 'set-parted', 'get-parted', 'system', 'type', 'meta', 'parse', 'eval', 'format', 'show', 'print', 'println', 'ser', 'de', 'resolve', 'nil?', 'null?', 'empty?', 'atom?', 'list?', 'date', 'time', 'timestamp', 'guid', 'year', 'month', 'mm', 'dd', 'hh', 'mi', 'ss', 'ms', 'lower', 'upper', 'trim', 'ltrim', 'rtrim', 'like', 'ss', 'ssr', 'vs', 'sv', 'rand', 'deal', 'roll', 'env', 'gc', 'args', 'timer', 'sysinfo', 'memstat', 'timeit', 'loadfn', 'internals', 'not', 'unify', 'diverse']);
        const TYPES = new Set(['Timestamp', 'String', 'F64', 'I64', 'Bool', 'Symbol', 'Time', 'Date', 'Guid', 'Char', 'I32', 'F32', 'U64', 'U32', 'I16', 'U16', 'I8', 'U8', 'B8', 'C8', 'List', 'Table', 'Dict', 'Lambda']);
        const CONSTANTS = new Set(['true', 'false', 'nil']);
        const SPECIAL_VARS = new Set(['self', 'it']);

        function escapeHtml(text) {
            return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        }

        function highlightSyntax(code) {
            if (!code) return '';
            
            let result = '';
            let i = 0;
            
            while (i < code.length) {
                const ch = code[i];
                const rest = code.slice(i);
                
                // Comment
                if (ch === ';') {
                    const end = code.indexOf('\\n', i);
                    const comment = end === -1 ? code.slice(i) : code.slice(i, end);
                    result += '<span class="syn-comment">' + escapeHtml(comment) + '</span>';
                    i += comment.length;
                    continue;
                }
                
                // String
                if (ch === '"') {
                    let j = i + 1;
                    while (j < code.length && code[j] !== '"') {
                        if (code[j] === '\\\\' && j + 1 < code.length) j += 2;
                        else j++;
                    }
                    const str = code.slice(i, j + 1);
                    result += '<span class="syn-string">' + escapeHtml(str) + '</span>';
                    i = j + 1;
                    continue;
                }
                
                // Quoted symbol 'symbol
                if (ch === "'" && i + 1 < code.length && /[a-zA-Z_]/.test(code[i + 1])) {
                    const match = rest.match(/^'[a-zA-Z_][a-zA-Z0-9_\\-?!.]*/);
                    if (match) {
                        result += '<span class="syn-symbol">' + escapeHtml(match[0]) + '</span>';
                        i += match[0].length;
                        continue;
                    }
                }
                
                // Keyword :keyword
                if (ch === ':' && i + 1 < code.length && /[a-zA-Z_]/.test(code[i + 1])) {
                    const match = rest.match(/^:[a-zA-Z_][a-zA-Z0-9_\\-?!]*/);
                    if (match) {
                        result += '<span class="syn-symbol">' + escapeHtml(match[0]) + '</span>';
                        i += match[0].length;
                        continue;
                    }
                }
                
                // GUID
                const guidMatch = rest.match(/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/);
                if (guidMatch) {
                    result += '<span class="syn-constant">' + escapeHtml(guidMatch[0]) + '</span>';
                    i += guidMatch[0].length;
                    continue;
                }
                
                // Timestamp YYYY.MM.DDThh:mm:ss
                const tsMatch = rest.match(/^\\d{4}\\.\\d{2}\\.\\d{2}[DT]\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?/);
                if (tsMatch) {
                    result += '<span class="syn-constant">' + escapeHtml(tsMatch[0]) + '</span>';
                    i += tsMatch[0].length;
                    continue;
                }
                
                // Date YYYY.MM.DD
                const dateMatch = rest.match(/^\\d{4}\\.\\d{2}\\.\\d{2}(?![DT])/);
                if (dateMatch) {
                    result += '<span class="syn-constant">' + escapeHtml(dateMatch[0]) + '</span>';
                    i += dateMatch[0].length;
                    continue;
                }
                
                // Time HH:MM:SS
                const timeMatch = rest.match(/^-?\\d{1,2}:\\d{2}:\\d{2}(?:\\.\\d+)?/);
                if (timeMatch) {
                    result += '<span class="syn-constant">' + escapeHtml(timeMatch[0]) + '</span>';
                    i += timeMatch[0].length;
                    continue;
                }
                
                // Null literals 0N...
                const nullMatch = rest.match(/^0N[0hiditplgsfp]/);
                if (nullMatch) {
                    result += '<span class="syn-constant">' + escapeHtml(nullMatch[0]) + '</span>';
                    i += nullMatch[0].length;
                    continue;
                }
                
                // Infinity/NaN
                const infMatch = rest.match(/^-?0[wWnN]/);
                if (infMatch) {
                    result += '<span class="syn-constant">' + escapeHtml(infMatch[0]) + '</span>';
                    i += infMatch[0].length;
                    continue;
                }
                
                // Hex number
                const hexMatch = rest.match(/^0x[0-9a-fA-F]+/);
                if (hexMatch) {
                    result += '<span class="syn-number">' + escapeHtml(hexMatch[0]) + '</span>';
                    i += hexMatch[0].length;
                    continue;
                }
                
                // Float number
                const floatMatch = rest.match(/^-?\\d+\\.\\d+(?:[eE][+-]?\\d+)?[fF]?/);
                if (floatMatch) {
                    result += '<span class="syn-number">' + escapeHtml(floatMatch[0]) + '</span>';
                    i += floatMatch[0].length;
                    continue;
                }
                
                // Integer number
                const intMatch = rest.match(/^-?\\d+[iIjJhHbBlL]?/);
                if (intMatch && (i === 0 || !/[a-zA-Z_]/.test(code[i-1]))) {
                    result += '<span class="syn-number">' + escapeHtml(intMatch[0]) + '</span>';
                    i += intMatch[0].length;
                    continue;
                }
                
                // Identifier or keyword
                const idMatch = rest.match(/^[a-zA-Z_][a-zA-Z0-9_\\-?!]*/);
                if (idMatch) {
                    const word = idMatch[0];
                    let cls = '';
                    if (KEYWORDS.has(word)) cls = 'syn-keyword';
                    else if (QUERY_KW.has(word)) cls = 'syn-keyword';
                    else if (CORE_FNS.has(word)) cls = 'syn-core-fn';
                    else if (TYPES.has(word)) cls = 'syn-type';
                    else if (CONSTANTS.has(word)) cls = 'syn-constant';
                    else if (SPECIAL_VARS.has(word)) cls = 'syn-special-var';
                    else cls = 'syn-function';
                    
                    result += '<span class="' + cls + '">' + escapeHtml(word) + '</span>';
                    i += word.length;
                    continue;
                }
                
                // Parentheses
                if (ch === '(' || ch === ')') {
                    result += '<span class="syn-paren">' + escapeHtml(ch) + '</span>';
                    i++;
                    continue;
                }
                
                // Brackets
                if (ch === '[' || ch === ']') {
                    result += '<span class="syn-bracket">' + escapeHtml(ch) + '</span>';
                    i++;
                    continue;
                }
                
                // Braces
                if (ch === '{' || ch === '}') {
                    result += '<span class="syn-brace">' + escapeHtml(ch) + '</span>';
                    i++;
                    continue;
                }
                
                // Operators
                if ('+-*/%&|^~<>!=@#$_.?'.includes(ch)) {
                    result += '<span class="syn-operator">' + escapeHtml(ch) + '</span>';
                    i++;
                    continue;
                }
                
                // Default
                result += escapeHtml(ch);
                i++;
            }
            
            return result;
        }

        function updateHighlight() {
            if (syntaxHighlight && input) {
                if (input.value) {
                    syntaxHighlight.innerHTML = highlightSyntax(input.value);
                    syntaxHighlight.style.display = 'block';
                } else {
                    syntaxHighlight.innerHTML = '';
                    syntaxHighlight.style.display = 'none';
                }
            }
        }

        // Autocomplete functions
        function getWordAtCursor() {
            if (!input) return { word: '', start: 0 };
            const text = input.value;
            const cursor = input.selectionStart || 0;
            
            // Find word boundaries (allow - and ? in identifiers)
            let start = cursor;
            while (start > 0 && /[a-zA-Z0-9_\\-?!]/.test(text[start - 1])) {
                start--;
            }
            
            const word = text.slice(start, cursor);
            return { word, start };
        }

        function filterAutocomplete(prefix) {
            if (!prefix || prefix.length < 1) return [];
            
            const lowerPrefix = prefix.toLowerCase();
            return AUTOCOMPLETE_DATA
                .filter(item => item.name.toLowerCase().startsWith(lowerPrefix))
                .slice(0, 15); // Limit to 15 suggestions
        }

        function renderAutocomplete() {
            if (!autocompleteDropdown) return;
            
            if (autocompleteItems.length === 0) {
                autocompleteDropdown.classList.remove('visible');
                autocompleteVisible = false;
                return;
            }

            autocompleteDropdown.innerHTML = autocompleteItems.map((item, idx) => {
                const selected = idx === autocompleteSelectedIndex ? 'selected' : '';
                return '<div class="autocomplete-item ' + selected + '" data-index="' + idx + '">' +
                    '<span class="autocomplete-item-name">' + escapeHtml(item.name) + '</span>' +
                    '<span class="autocomplete-item-kind">' + item.kind + '</span>' +
                    '<span class="autocomplete-item-detail">' + escapeHtml(item.detail) + '</span>' +
                '</div>';
            }).join('');

            autocompleteDropdown.classList.add('visible');
            autocompleteVisible = true;

            // Scroll selected item into view
            const selectedEl = autocompleteDropdown.querySelector('.autocomplete-item.selected');
            if (selectedEl) {
                selectedEl.scrollIntoView({ block: 'nearest' });
            }
        }

        function updateAutocomplete() {
            const { word, start } = getWordAtCursor();
            currentPrefix = word;
            prefixStart = start;
            
            autocompleteItems = filterAutocomplete(word);
            autocompleteSelectedIndex = 0;
            renderAutocomplete();
        }

        function hideAutocomplete() {
            if (autocompleteDropdown) {
                autocompleteDropdown.classList.remove('visible');
            }
            autocompleteVisible = false;
            autocompleteItems = [];
        }

        function applyAutocomplete(index) {
            if (!input || index < 0 || index >= autocompleteItems.length) return;
            
            const item = autocompleteItems[index];
            const text = input.value;
            const newText = text.slice(0, prefixStart) + item.name + text.slice(input.selectionStart || prefixStart);
            
            input.value = newText;
            const newCursor = prefixStart + item.name.length;
            input.setSelectionRange(newCursor, newCursor);
            
            hideAutocomplete();
            updateHighlight();
            saveState();
        }

        if (input) {
            input.addEventListener('keydown', (e) => {
                // Handle autocomplete navigation
                if (autocompleteVisible) {
                    if (e.key === 'ArrowDown') {
                        e.preventDefault();
                        autocompleteSelectedIndex = Math.min(autocompleteSelectedIndex + 1, autocompleteItems.length - 1);
                        renderAutocomplete();
                        return;
                    } else if (e.key === 'ArrowUp') {
                        e.preventDefault();
                        autocompleteSelectedIndex = Math.max(autocompleteSelectedIndex - 1, 0);
                        renderAutocomplete();
                        return;
                    } else if (e.key === 'Tab' || e.key === 'Enter') {
                        if (autocompleteItems.length > 0) {
                            e.preventDefault();
                            applyAutocomplete(autocompleteSelectedIndex);
                            return;
                        }
                    } else if (e.key === 'Escape') {
                        e.preventDefault();
                        hideAutocomplete();
                        return;
                    }
                }
                
                if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    executeCommand();
                } else if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    navigateHistory(-1);
                } else if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    navigateHistory(1);
                } else if (e.key === 'Escape') {
                    hideAutocomplete();
                }
            });

            input.addEventListener('input', () => {
                updateHighlight();
                updateAutocomplete();
                saveState();
            });

            // Handle click on autocomplete items
            if (autocompleteDropdown) {
                autocompleteDropdown.addEventListener('click', (e) => {
                    const item = e.target.closest('.autocomplete-item');
                    if (item) {
                        const index = parseInt(item.dataset.index, 10);
                        applyAutocomplete(index);
                    }
                });
            }

            // Hide autocomplete on blur (with small delay to allow click)
            input.addEventListener('blur', () => {
                setTimeout(hideAutocomplete, 150);
            });
        }

        function saveState() {
            vscode.setState({
                commandHistory,
                historyIndex,
                inputValue: input ? input.value : ''
            });
        }

        function executeCommand() {
            const text = input.value.trim();
            if (!text) return;
            
            commandHistory.push(text);
            historyIndex = commandHistory.length;
            
            vscode.postMessage({ command: 'execute', text });
            input.value = '';
            saveState();
        }

        function navigateHistory(direction) {
            if (commandHistory.length === 0) return;
            
            historyIndex += direction;
            
            if (historyIndex < 0) {
                historyIndex = 0;
            } else if (historyIndex >= commandHistory.length) {
                historyIndex = commandHistory.length;
                input.value = '';
                updateHighlight();
                saveState();
                return;
            }
            
            input.value = commandHistory[historyIndex];
            input.setSelectionRange(input.value.length, input.value.length);
            updateHighlight();
            saveState();
        }

        function clearHistory() {
            vscode.postMessage({ command: 'clear' });
        }

        function disconnect() {
            vscode.postMessage({ command: 'disconnect' });
        }

        function toggleEnv() {
            vscode.postMessage({ command: 'toggleEnv' });
        }

        function refreshEnv() {
            vscode.postMessage({ command: 'refreshEnv' });
        }

        // Environment panel resize
        const envPanel = document.getElementById('env-panel');
        const resizeHandle = document.getElementById('env-resize-handle');
        
        if (envPanel && resizeHandle) {
            let isResizing = false;
            let startX = 0;
            let startWidth = 0;

            resizeHandle.addEventListener('mousedown', (e) => {
                isResizing = true;
                startX = e.clientX;
                startWidth = envPanel.offsetWidth;
                resizeHandle.classList.add('dragging');
                document.body.style.cursor = 'ew-resize';
                document.body.style.userSelect = 'none';
                e.preventDefault();
            });

            document.addEventListener('mousemove', (e) => {
                if (!isResizing) return;
                const delta = startX - e.clientX;
                const newWidth = Math.min(500, Math.max(150, startWidth + delta));
                envPanel.style.width = newWidth + 'px';
            });

            document.addEventListener('mouseup', () => {
                if (isResizing) {
                    isResizing = false;
                    resizeHandle.classList.remove('dragging');
                    document.body.style.cursor = '';
                    document.body.style.userSelect = '';
                    vscode.postMessage({ command: 'setEnvWidth', width: envPanel.offsetWidth });
                }
            });
        }

        function inspectVar(name) {
            vscode.postMessage({ command: 'inspectVar', name });
        }

        // Pagination handlers
        document.addEventListener('click', (e) => {
            const target = e.target;
            if (!target.classList || !target.classList.contains('rf-pagination-btn')) return;
            
            const paginationDiv = target.closest('.rf-pagination');
            if (!paginationDiv) return;
            
            const historyId = paginationDiv.dataset.historyId;
            const pageSizeSelect = paginationDiv.querySelector('.rf-pagination-select');
            const pageSize = parseInt(pageSizeSelect?.value || '100', 10);
            
            // Parse current page from the pagination info text
            const pageStrong = paginationDiv.querySelector('.rf-pagination-page strong');
            const currentPage = parseInt(pageStrong?.textContent || '1', 10) - 1;
            const totalPagesStrong = paginationDiv.querySelectorAll('.rf-pagination-page strong')[1];
            const totalPages = parseInt(totalPagesStrong?.textContent || '1', 10);
            
            let newPage = currentPage;
            
            if (target.classList.contains('rf-pagination-first')) {
                newPage = 0;
            } else if (target.classList.contains('rf-pagination-prev')) {
                newPage = Math.max(0, currentPage - 1);
            } else if (target.classList.contains('rf-pagination-next')) {
                newPage = Math.min(totalPages - 1, currentPage + 1);
            } else if (target.classList.contains('rf-pagination-last')) {
                newPage = totalPages - 1;
            }
            
            if (newPage !== currentPage) {
                vscode.postMessage({ command: 'changePage', historyId, page: newPage, pageSize });
            }
        });

        document.addEventListener('change', (e) => {
            const target = e.target;
            if (!target.classList || !target.classList.contains('rf-pagination-select')) return;
            
            const historyId = target.dataset.historyId;
            const pageSize = parseInt(target.value, 10);
            
            vscode.postMessage({ command: 'changePageSize', historyId, pageSize });
        });

        if (input && !input.disabled) input.focus();
    </script>
</body>
</html>`;
    }

    private escapeHtml(text: string): string {
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    private highlightSyntax(code: string): string {
        if (!code) return '';

        const KEYWORDS = new Set(['fn', 'do', 'let', 'if', 'cond', 'when', 'unless', 'set', 'try', 'catch', 'return', 'exit', 'raise', 'throw', 'quote', 'and', 'or', 'def', 'defn', 'loop', 'recur']);
        const QUERY_KW = new Set(['select', 'update', 'delete', 'insert', 'upsert', 'alter', 'modify', 'from', 'where', 'by', 'take', 'into', 'as']);
        const CORE_FNS = new Set(['list', 'enlist', 'table', 'dict', 'first', 'last', 'count', 'reverse', 'distinct', 'raze', 'concat', 'remove', 'filter', 'til', 'drop', 'row', 'key', 'value', 'keys', 'values', 'flip', 'get', 'at', 'in', 'within', 'sect', 'except', 'union', 'find', 'group', 'ungroup', 'enum', 'xbar', 'split', 'bin', 'binr', 'sum', 'avg', 'med', 'dev', 'var', 'min', 'max', 'all', 'any', 'prod', 'wavg', 'wsum', 'cov', 'cor', 'sums', 'prds', 'mins', 'maxs', 'avgs', 'msum', 'mcount', 'mavg', 'mmin', 'mmax', 'abs', 'neg', 'floor', 'ceil', 'round', 'sqrt', 'exp', 'log', 'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'signum', 'mod', 'div', 'reciprocal', 'asc', 'desc', 'iasc', 'idesc', 'rank', 'xasc', 'xdesc', 'xrank', 'sort', 'apply', 'map', 'pmap', 'fold', 'scan', 'map-left', 'map-right', 'fold-left', 'fold-right', 'scan-left', 'scan-right', 'each', 'peach', 'over', 'converge', 'left-join', 'inner-join', 'asof-join', 'window-join', 'lj', 'ij', 'aj', 'wj', 'uj', 'pj', 'read', 'write', 'read-csv', 'write-csv', 'hopen', 'hclose', 'load', 'save', 'set-splayed', 'get-splayed', 'set-parted', 'get-parted', 'system', 'type', 'meta', 'parse', 'eval', 'format', 'show', 'print', 'println', 'ser', 'de', 'resolve', 'nil?', 'null?', 'empty?', 'atom?', 'list?', 'date', 'time', 'timestamp', 'guid', 'year', 'month', 'mm', 'dd', 'hh', 'mi', 'ss', 'ms', 'lower', 'upper', 'trim', 'ltrim', 'rtrim', 'like', 'ss', 'ssr', 'vs', 'sv', 'rand', 'deal', 'roll', 'env', 'gc', 'args', 'timer', 'sysinfo', 'memstat', 'timeit', 'loadfn', 'internals', 'not', 'unify', 'diverse']);
        const TYPES = new Set(['Timestamp', 'String', 'F64', 'I64', 'Bool', 'Symbol', 'Time', 'Date', 'Guid', 'Char', 'I32', 'F32', 'U64', 'U32', 'I16', 'U16', 'I8', 'U8', 'B8', 'C8', 'List', 'Table', 'Dict', 'Lambda']);
        const CONSTANTS = new Set(['true', 'false', 'nil']);
        const SPECIAL_VARS = new Set(['self', 'it']);

        let result = '';
        let i = 0;

        while (i < code.length) {
            const ch = code[i];
            const rest = code.slice(i);

            // Comment
            if (ch === ';') {
                const end = code.indexOf('\n', i);
                const comment = end === -1 ? code.slice(i) : code.slice(i, end);
                result += `<span class="syn-comment">${this.escapeHtml(comment)}</span>`;
                i += comment.length;
                continue;
            }

            // String
            if (ch === '"') {
                let j = i + 1;
                while (j < code.length && code[j] !== '"') {
                    if (code[j] === '\\' && j + 1 < code.length) j += 2;
                    else j++;
                }
                const str = code.slice(i, j + 1);
                result += `<span class="syn-string">${this.escapeHtml(str)}</span>`;
                i = j + 1;
                continue;
            }

            // Quoted symbol 'symbol
            if (ch === "'" && i + 1 < code.length && /[a-zA-Z_]/.test(code[i + 1])) {
                const match = rest.match(/^'[a-zA-Z_][a-zA-Z0-9_\-?!.]*/);
                if (match) {
                    result += `<span class="syn-symbol">${this.escapeHtml(match[0])}</span>`;
                    i += match[0].length;
                    continue;
                }
            }

            // Keyword :keyword
            if (ch === ':' && i + 1 < code.length && /[a-zA-Z_]/.test(code[i + 1])) {
                const match = rest.match(/^:[a-zA-Z_][a-zA-Z0-9_\-?!]*/);
                if (match) {
                    result += `<span class="syn-symbol">${this.escapeHtml(match[0])}</span>`;
                    i += match[0].length;
                    continue;
                }
            }

            // GUID
            const guidMatch = rest.match(/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/);
            if (guidMatch) {
                result += `<span class="syn-constant">${this.escapeHtml(guidMatch[0])}</span>`;
                i += guidMatch[0].length;
                continue;
            }

            // Timestamp YYYY.MM.DDThh:mm:ss
            const tsMatch = rest.match(/^\d{4}\.\d{2}\.\d{2}[DT]\d{2}:\d{2}:\d{2}(?:\.\d+)?/);
            if (tsMatch) {
                result += `<span class="syn-constant">${this.escapeHtml(tsMatch[0])}</span>`;
                i += tsMatch[0].length;
                continue;
            }

            // Date YYYY.MM.DD
            const dateMatch = rest.match(/^\d{4}\.\d{2}\.\d{2}(?![DT])/);
            if (dateMatch) {
                result += `<span class="syn-constant">${this.escapeHtml(dateMatch[0])}</span>`;
                i += dateMatch[0].length;
                continue;
            }

            // Time HH:MM:SS
            const timeMatch = rest.match(/^-?\d{1,2}:\d{2}:\d{2}(?:\.\d+)?/);
            if (timeMatch) {
                result += `<span class="syn-constant">${this.escapeHtml(timeMatch[0])}</span>`;
                i += timeMatch[0].length;
                continue;
            }

            // Null literals 0N...
            const nullMatch = rest.match(/^0N[0hiditplgsfp]/);
            if (nullMatch) {
                result += `<span class="syn-constant">${this.escapeHtml(nullMatch[0])}</span>`;
                i += nullMatch[0].length;
                continue;
            }

            // Infinity/NaN
            const infMatch = rest.match(/^-?0[wWnN]/);
            if (infMatch) {
                result += `<span class="syn-constant">${this.escapeHtml(infMatch[0])}</span>`;
                i += infMatch[0].length;
                continue;
            }

            // Hex number
            const hexMatch = rest.match(/^0x[0-9a-fA-F]+/);
            if (hexMatch) {
                result += `<span class="syn-number">${this.escapeHtml(hexMatch[0])}</span>`;
                i += hexMatch[0].length;
                continue;
            }

            // Float number
            const floatMatch = rest.match(/^-?\d+\.\d+(?:[eE][+-]?\d+)?[fF]?/);
            if (floatMatch) {
                result += `<span class="syn-number">${this.escapeHtml(floatMatch[0])}</span>`;
                i += floatMatch[0].length;
                continue;
            }

            // Integer number
            const intMatch = rest.match(/^-?\d+[iIjJhHbBlL]?/);
            if (intMatch && (i === 0 || !/[a-zA-Z_]/.test(code[i - 1]))) {
                result += `<span class="syn-number">${this.escapeHtml(intMatch[0])}</span>`;
                i += intMatch[0].length;
                continue;
            }

            // Identifier or keyword
            const idMatch = rest.match(/^[a-zA-Z_][a-zA-Z0-9_\-?!]*/);
            if (idMatch) {
                const word = idMatch[0];
                let cls = '';
                if (KEYWORDS.has(word)) cls = 'syn-keyword';
                else if (QUERY_KW.has(word)) cls = 'syn-keyword';
                else if (CORE_FNS.has(word)) cls = 'syn-core-fn';
                else if (TYPES.has(word)) cls = 'syn-type';
                else if (CONSTANTS.has(word)) cls = 'syn-constant';
                else if (SPECIAL_VARS.has(word)) cls = 'syn-special-var';
                else cls = 'syn-function';

                result += `<span class="${cls}">${this.escapeHtml(word)}</span>`;
                i += word.length;
                continue;
            }

            // Parentheses
            if (ch === '(' || ch === ')') {
                result += `<span class="syn-paren">${this.escapeHtml(ch)}</span>`;
                i++;
                continue;
            }

            // Brackets
            if (ch === '[' || ch === ']') {
                result += `<span class="syn-bracket">${this.escapeHtml(ch)}</span>`;
                i++;
                continue;
            }

            // Braces
            if (ch === '{' || ch === '}') {
                result += `<span class="syn-brace">${this.escapeHtml(ch)}</span>`;
                i++;
                continue;
            }

            // Operators
            if ('+-*/%&|^~<>!=@#$_.?'.includes(ch)) {
                result += `<span class="syn-operator">${this.escapeHtml(ch)}</span>`;
                i++;
                continue;
            }

            // Default
            result += this.escapeHtml(ch);
            i++;
        }

        return result;
    }

    public dispose(): void {
        RayforceReplPanel.currentPanel = undefined;

        if (this.ipcClient) {
            this.ipcClient.disconnect();
        }

        this.panel.dispose();

        while (this.disposables.length) {
            const d = this.disposables.pop();
            if (d) {
                d.dispose();
            }
        }
    }
}

