import * as vscode from 'vscode';
import { RayforceProcess } from './instancesProvider';

export class ProcessInfoProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'rayforceProcessInfo';

    private view?: vscode.WebviewView;
    private process: RayforceProcess | null = null;
    private isRemote: boolean = false;
    private onTerminate: (() => void) | null = null;

    constructor(private readonly extensionUri: vscode.Uri) {}

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ): void {
        this.view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this.extensionUri]
        };

        webviewView.webview.onDidReceiveMessage(async message => {
            if (message.command === 'terminate') {
                if (this.onTerminate) {
                    await this.onTerminate();
                }
            }
        });

        this.updateView();
    }

    public setOnTerminate(callback: () => void): void {
        this.onTerminate = callback;
    }

    public updateProcess(process: RayforceProcess | null): void {
        this.process = process;
        this.updateView();
    }

    public setIsRemote(isRemote: boolean): void {
        this.isRemote = isRemote;
        this.updateView();
    }

    private updateView(): void {
        if (!this.view) return;
        this.view.webview.html = this.getHtmlContent();
    }

    private getHtmlContent(): string {
        const process = this.process;
        const logoWhiteUri = this.view?.webview.asWebviewUri(
            vscode.Uri.joinPath(this.extensionUri, 'assets', 'logo_white.svg')
        );
        const logoBlackUri = this.view?.webview.asWebviewUri(
            vscode.Uri.joinPath(this.extensionUri, 'assets', 'logo_black.svg')
        );

        if (this.isRemote || !process) {
            const message = this.isRemote 
                ? 'Remote connection (no process info)' 
                : 'No instance connected';
            return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        body {
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            padding: 16px;
            color: var(--vscode-foreground);
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            min-height: 120px;
        }
        .empty-state {
            text-align: center;
            opacity: 0.6;
        }
        .empty-icon {
            font-size: 32px;
            margin-bottom: 8px;
        }
        .empty-text {
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
        }
    </style>
</head>
<body>
    <div class="empty-state">
        <div class="empty-icon">${this.isRemote ? '☁' : '○'}</div>
        <div class="empty-text">${message}</div>
    </div>
</body>
</html>`;
        }

        const cpuPercent = process.cpu?.toFixed(1) || '0.0';
        const memPercent = process.memory?.toFixed(1) || '0.0';
        
        // Determine CPU status color
        let cpuColor = 'var(--vscode-testing-iconPassed, #4caf50)';
        if ((process.cpu || 0) > 80) {
            cpuColor = 'var(--vscode-testing-iconFailed, #f44336)';
        } else if ((process.cpu || 0) > 50) {
            cpuColor = 'var(--vscode-charts-yellow, #ffb300)';
        }
        
        // Determine Memory status color
        let memColor = 'var(--vscode-testing-iconPassed, #4caf50)';
        if ((process.memory || 0) > 80) {
            memColor = 'var(--vscode-testing-iconFailed, #f44336)';
        } else if ((process.memory || 0) > 50) {
            memColor = 'var(--vscode-charts-yellow, #ffb300)';
        }

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        body {
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            padding: 12px 16px;
            color: var(--vscode-foreground);
            margin: 0;
        }

        .header {
            display: flex;
            align-items: center;
            gap: 10px;
            margin-bottom: 16px;
            padding-bottom: 12px;
            border-bottom: 1px solid var(--vscode-panel-border);
        }

        .logo {
            width: 24px;
            height: 24px;
        }

        .logo-light { display: none; }
        .logo-dark { display: block; }
        body.vscode-light .logo-light { display: block; }
        body.vscode-light .logo-dark { display: none; }

        .header-info {
            flex: 1;
        }

        .port-label {
            font-size: 14px;
            font-weight: 600;
            color: var(--vscode-foreground);
        }

        .pid-label {
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
        }

        .status-dot {
            width: 8px;
            height: 8px;
            background: var(--vscode-testing-iconPassed, #4caf50);
            border-radius: 50%;
            animation: pulse 2s ease-in-out infinite;
        }

        @keyframes pulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.5; }
        }

        .metrics {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 12px;
        }

        .metric {
            background: var(--vscode-editor-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 6px;
            padding: 12px;
            text-align: center;
        }

        .metric-icon {
            font-size: 16px;
            margin-bottom: 4px;
        }

        .metric-value {
            font-size: 20px;
            font-weight: 600;
            margin-bottom: 2px;
        }

        .metric-label {
            font-size: 10px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            color: var(--vscode-descriptionForeground);
        }

        .progress-bar {
            height: 4px;
            background: var(--vscode-panel-border);
            border-radius: 2px;
            margin-top: 8px;
            overflow: hidden;
        }

        .progress-fill {
            height: 100%;
            border-radius: 2px;
            transition: width 0.3s ease;
        }

        .command-section {
            margin-top: 16px;
            padding-top: 12px;
            border-top: 1px solid var(--vscode-panel-border);
        }

        .command-label {
            font-size: 10px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            color: var(--vscode-descriptionForeground);
            margin-bottom: 6px;
        }

        .command-text {
            font-family: var(--vscode-editor-font-family, monospace);
            font-size: 11px;
            color: var(--vscode-textLink-foreground);
            word-break: break-all;
            background: var(--vscode-editor-background);
            padding: 8px 10px;
            border-radius: 4px;
            border: 1px solid var(--vscode-panel-border);
        }

        .terminate-btn {
            width: 100%;
            margin-top: 16px;
            padding: 8px 12px;
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            border: 1px solid var(--vscode-button-border, transparent);
            border-radius: 4px;
            font-family: var(--vscode-font-family);
            font-size: 12px;
            cursor: pointer;
            transition: all 0.15s;
        }

        .terminate-btn:hover {
            background: var(--vscode-errorForeground);
            color: white;
        }
    </style>
</head>
<body>
    <div class="header">
        <img src="${logoWhiteUri}" class="logo logo-dark" alt="Rayforce" />
        <img src="${logoBlackUri}" class="logo logo-light" alt="Rayforce" />
        <div class="header-info">
            <div class="port-label">localhost:${process.port}</div>
            <div class="pid-label">PID ${process.pid}</div>
        </div>
        <div class="status-dot"></div>
    </div>

    <div class="metrics">
        <div class="metric">
            <div class="metric-value" style="color: ${cpuColor}">${cpuPercent}%</div>
            <div class="metric-label">CPU</div>
            <div class="progress-bar">
                <div class="progress-fill" style="width: ${Math.min(process.cpu || 0, 100)}%; background: ${cpuColor}"></div>
            </div>
        </div>
        <div class="metric">
            <div class="metric-value" style="color: ${memColor}">${memPercent}%</div>
            <div class="metric-label">Memory</div>
            <div class="progress-bar">
                <div class="progress-fill" style="width: ${Math.min(process.memory || 0, 100)}%; background: ${memColor}"></div>
            </div>
        </div>
    </div>

    <div class="command-section">
        <div class="command-text">${this.escapeHtml(process.command + ' ' + process.args)}</div>
    </div>

    <button class="terminate-btn" id="terminateBtn">⏻ Terminate Instance</button>

    <script>
        const vscode = acquireVsCodeApi();
        const btn = document.getElementById('terminateBtn');
        let clickCount = 0;
        let clickTimer = null;

        btn.addEventListener('click', () => {
            clickCount++;
            if (clickCount === 1) {
                btn.textContent = '⚠ Click again to confirm';
                btn.style.background = 'var(--vscode-inputValidation-warningBackground)';
                clickTimer = setTimeout(() => {
                    clickCount = 0;
                    btn.textContent = '⏻ Terminate Instance';
                    btn.style.background = '';
                }, 2000);
            } else if (clickCount >= 2) {
                clearTimeout(clickTimer);
                btn.textContent = 'Terminating...';
                btn.disabled = true;
                vscode.postMessage({ command: 'terminate' });
            }
        });
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
}

