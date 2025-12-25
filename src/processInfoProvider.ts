import * as vscode from 'vscode';

interface ConnectedInstance {
    host: string;
    port: number;
    isRemote: boolean;
}

export class ProcessInfoProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'rayforceProcessInfo';

    private view?: vscode.WebviewView;
    private connectedInstance: ConnectedInstance | null = null;

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

        this.updateView();
    }

    public updateConnectedInstance(host: string | null, port: number | null, isRemote: boolean): void {
        if (host && port) {
            this.connectedInstance = { host, port, isRemote };
        } else {
            this.connectedInstance = null;
        }
        this.updateView();
    }

    private updateView(): void {
        if (!this.view) return;
        this.view.webview.html = this.getHtmlContent();
    }

    private getHtmlContent(): string {
        const logoWhiteUri = this.view?.webview.asWebviewUri(
            vscode.Uri.joinPath(this.extensionUri, 'assets', 'logo_white.svg')
        );
        const logoBlackUri = this.view?.webview.asWebviewUri(
            vscode.Uri.joinPath(this.extensionUri, 'assets', 'logo_black.svg')
        );

        if (!this.connectedInstance) {
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
        <div class="empty-icon">○</div>
        <div class="empty-text">No instance connected</div>
    </div>
</body>
</html>`;
        }

        const instance = this.connectedInstance;
        const instanceLabel = instance.host === 'localhost' ? `localhost:${instance.port}` : `${instance.host}:${instance.port}`;
        const instanceType = instance.isRemote ? 'Remote Instance' : 'Local Instance';

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

        .instance-label {
            font-size: 14px;
            font-weight: 600;
            color: var(--vscode-foreground);
            margin-bottom: 4px;
        }

        .instance-type {
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

        .info-section {
            margin-top: 12px;
        }

        .info-item {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 8px 0;
            border-bottom: 1px solid var(--vscode-panel-border);
        }

        .info-item:last-child {
            border-bottom: none;
        }

        .info-label {
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }

        .info-value {
            font-size: 12px;
            font-weight: 500;
            color: var(--vscode-foreground);
            font-family: var(--vscode-editor-font-family, monospace);
        }
    </style>
</head>
<body>
    <div class="header">
        <img src="${logoWhiteUri}" class="logo logo-dark" alt="Rayforce" />
        <img src="${logoBlackUri}" class="logo logo-light" alt="Rayforce" />
        <div class="header-info">
            <div class="instance-label">${instanceLabel}</div>
            <div class="instance-type">${instanceType}</div>
        </div>
        <div class="status-dot"></div>
    </div>

    <div class="info-section">
        <div class="info-item">
            <span class="info-label">Host</span>
            <span class="info-value">${this.escapeHtml(instance.host)}</span>
        </div>
        <div class="info-item">
            <span class="info-label">Port</span>
            <span class="info-value">${instance.port}</span>
        </div>
        <div class="info-item">
            <span class="info-label">Status</span>
            <span class="info-value" style="color: var(--vscode-testing-iconPassed, #4caf50)">● Connected</span>
        </div>
    </div>
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

