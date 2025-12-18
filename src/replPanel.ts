import * as vscode from 'vscode';
import { RayforceIpcClient, isError, RayforceValue, RayforceDict } from './rayforceIpc';
import { formatValueHtml, formatValueText, getPrettyPrintStyles, detectType, defaultConfig } from './prettyPrint';

interface EnvEntry {
    name: string;
    type: string;
    value: string;
}

interface HistoryEntry {
    input: string;
    output: RayforceValue | string;  // Store raw value or string for system messages
    isError: boolean;
    isSystem: boolean;
}

export class RayforceReplPanel {
    public static currentPanel: RayforceReplPanel | undefined;
    private static readonly viewType = 'rayforceRepl';

    private readonly panel: vscode.WebviewPanel;
    private readonly extensionUri: vscode.Uri;
    private disposables: vscode.Disposable[] = [];

    private ipcClient: RayforceIpcClient | null = null;
    private port: number | null = null;
    private history: HistoryEntry[] = [];
    private envData: EnvEntry[] = [];
    private showEnv: boolean = true;
    private envWidth: number = 280;
    private connectionVersion: number = 0;  // Track connection changes to abort stale operations

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
        this.panel = panel;
        this.extensionUri = extensionUri;

        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
        this.panel.webview.onDidReceiveMessage(
            message => this.handleMessage(message),
            null,
            this.disposables
        );

        this.updateWebview();
    }

    public static createOrShow(extensionUri: vscode.Uri): RayforceReplPanel {
        const column = vscode.ViewColumn.Beside;

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

        RayforceReplPanel.currentPanel = new RayforceReplPanel(panel, extensionUri);
        return RayforceReplPanel.currentPanel;
    }

    public async connect(host: string, port: number): Promise<void> {
        if (this.ipcClient && this.ipcClient.isConnected() && this.port === port) {
            this.panel.reveal();
            return;
        }

        // Increment version to abort any pending operations
        this.connectionVersion++;
        const currentVersion = this.connectionVersion;

        if (this.ipcClient && this.port && this.port !== port) {
            this.ipcClient.disconnect();
            this.addSystemMessage(`Switching from localhost:${this.port}...`);
        } else if (this.ipcClient) {
            this.ipcClient.disconnect();
        }

        this.ipcClient = new RayforceIpcClient(host, port);
        this.port = port;

        try {
            await this.ipcClient.connect(5000);

            // Check if connection changed while we were connecting
            if (this.connectionVersion !== currentVersion) {
                return;
            }

            this.addSystemMessage(`Connected to localhost:${port}`);
            await this.refreshEnv();
        } catch (err) {
            // Check if connection changed while we were connecting
            if (this.connectionVersion !== currentVersion) {
                return;
            }

            const message = err instanceof Error ? err.message : String(err);
            this.addSystemMessage(`Failed to connect: ${message}`, true);
            this.ipcClient = null;
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
        this.port = null;
        this.envData = [];
    }

    public isConnected(): boolean {
        return this.ipcClient !== null && this.ipcClient.isConnected();
    }

    public getPort(): number | null {
        return this.port;
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
        }
    }

    private async refreshEnv(): Promise<void> {
        const currentVersion = this.connectionVersion;

        if (!this.ipcClient || !this.ipcClient.isConnected()) {
            this.envData = [];
            this.updateWebview();
            return;
        }

        try {
            const result = await this.ipcClient.execute('(env)');

            // Abort if connection changed
            if (this.connectionVersion !== currentVersion) return;

            this.envData = this.parseEnvResult(result);
        } catch (err) {
            // Abort if connection changed
            if (this.connectionVersion !== currentVersion) return;

            this.envData = [];
        }

        this.updateWebview();
    }

    private parseEnvResult(result: RayforceValue): EnvEntry[] {
        const entries: EnvEntry[] = [];

        if (result && typeof result === 'object' && '_type' in result && result._type === 'dict') {
            const dict = result as RayforceDict;
            const keys = dict.keys;
            const values = dict.values;

            if (Array.isArray(keys) && Array.isArray(values)) {
                for (let i = 0; i < keys.length; i++) {
                    const key = keys[i];
                    const val = values[i];

                    const name = typeof key === 'symbol'
                        ? Symbol.keyFor(key) || String(key)
                        : String(key);

                    // Skip internal/system variables
                    if (name.startsWith('.')) continue;

                    // Infer type from value (avoids expensive IPC calls)
                    const type = this.inferType(val);
                    const value = this.formatShortValue(val);
                    entries.push({ name, type, value });
                }
            }
        }

        // Sort alphabetically
        entries.sort((a, b) => a.name.localeCompare(b.name));

        return entries;
    }

    private inferType(val: RayforceValue): string {
        return detectType(val);
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

        try {
            const result = await this.ipcClient.execute(name);

            // Abort if connection changed
            if (this.connectionVersion !== currentVersion) return;

            this.history.push({
                input: name,
                output: result,
                isError: isError(result),
                isSystem: false
            });

            this.updateWebview();
        } catch (err) {
            // Ignore - connection likely changed
        }
    }

    private async executeCommand(input: string): Promise<void> {
        const currentVersion = this.connectionVersion;

        if (!input.trim()) return;

        if (!this.ipcClient || !this.ipcClient.isConnected()) {
            this.history.push({
                input,
                output: 'Not connected to any Rayforce instance',
                isError: true,
                isSystem: false
            });
            this.updateWebview();
            return;
        }

        try {
            const result = await this.ipcClient.execute(input);

            // Abort if connection changed
            if (this.connectionVersion !== currentVersion) return;

            this.history.push({
                input,
                output: result,
                isError: isError(result),
                isSystem: false
            });
        } catch (err) {
            // Abort if connection changed
            if (this.connectionVersion !== currentVersion) return;

            this.history.push({
                input,
                output: err instanceof Error ? err.message : String(err),
                isError: true,
                isSystem: false
            });
        }

        this.updateWebview();
    }

    private addSystemMessage(message: string, isError: boolean = false): void {
        this.history.push({ input: '', output: message, isError, isSystem: true });
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
                // User command with output - render with pretty print
                const outputHtml = typeof item.output === 'string'
                    ? `<span class="rf-error">${this.escapeHtml(item.output)}</span>`
                    : formatValueHtml(item.output as RayforceValue);
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
        
        const state = vscode.getState() || { commandHistory: [], historyIndex: -1, inputValue: '' };
        let commandHistory = state.commandHistory;
        let historyIndex = state.historyIndex;
        
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
                syntaxHighlight.innerHTML = highlightSyntax(input.value);
            }
        }

        if (input) {
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    executeCommand();
                } else if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    navigateHistory(-1);
                } else if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    navigateHistory(1);
                }
            });

            input.addEventListener('input', () => {
                updateHighlight();
                saveState();
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

