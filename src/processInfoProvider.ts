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
            enableScripts: false,
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
        const styleUri = this.view?.webview.asWebviewUri(
            vscode.Uri.joinPath(this.extensionUri, 'assets', 'processInfo.css')
        );
        const cspSource = this.view?.webview.cspSource || '';

        if (!this.connectedInstance) {
            return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource}; style-src ${cspSource}; script-src 'none';">
    <link href="${styleUri}" rel="stylesheet">
</head>
<body class="empty-body">
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
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource}; style-src ${cspSource}; script-src 'none';">
    <link href="${styleUri}" rel="stylesheet">
</head>
<body>
    <div class="header">
        <img src="${logoWhiteUri}" class="logo logo-dark" alt="Rayforce" />
        <img src="${logoBlackUri}" class="logo logo-light" alt="Rayforce" />
        <div class="header-info">
            <div class="instance-label">${this.escapeHtml(instanceLabel)}</div>
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
            <span class="info-value status-connected">● Connected</span>
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
