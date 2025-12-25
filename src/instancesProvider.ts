import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';

export interface RayforceProcess {
    pid: number;
    command: string;
    args: string;
    port: number;
    cpu?: number;
    memory?: number;
}

export interface RemoteConnection {
    host: string;
    port: number;
}

export type InstanceItem = RayforceInstanceItem | RemoteInstanceItem;

export class RayforceInstanceItem extends vscode.TreeItem {
    public readonly isRemote = false;
    
    constructor(
        public readonly process: RayforceProcess,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly isConnected: boolean = false
    ) {
        super(`localhost:${process.port}`, collapsibleState);
        
        if (isConnected) {
            this.description = '● connected';
            this.iconPath = new vscode.ThemeIcon('vm-running', new vscode.ThemeColor('testing.iconPassed'));
            this.tooltip = new vscode.MarkdownString(
                `### 🟢 Connected Instance\n\n` +
                `**Port:** \`${process.port}\`\n\n` +
                `**PID:** \`${process.pid}\`\n\n` +
                `**Command:** \`${process.command} ${process.args}\`\n\n` +
                `---\n_Click to reconnect or use context menu_`
            );
            // Make connected instance more prominent
            this.resourceUri = vscode.Uri.parse(`rayforce://connected/${process.port}`);
        } else {
            this.description = `PID ${process.pid}`;
            this.iconPath = new vscode.ThemeIcon('vm-outline');
            this.tooltip = new vscode.MarkdownString(
                `### Rayforce Instance\n\n` +
                `**Port:** \`${process.port}\`\n\n` +
                `**PID:** \`${process.pid}\`\n\n` +
                `**Command:** \`${process.command} ${process.args}\`\n\n` +
                `---\n_Click to connect_`
            );
        }
        
        this.contextValue = isConnected ? 'rayforceInstanceConnected' : 'rayforceInstance';
        
        this.command = {
            command: 'rayforce.connectToInstance',
            title: 'Connect to Instance',
            arguments: [this]
        };
    }
}

export class RemoteInstanceItem extends vscode.TreeItem {
    public readonly isRemote = true;
    
    constructor(
        public readonly connection: RemoteConnection,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly isConnected: boolean = false
    ) {
        super(`${connection.host}:${connection.port}`, collapsibleState);
        
        if (isConnected) {
            this.description = '● connected';
            this.iconPath = new vscode.ThemeIcon('remote', new vscode.ThemeColor('testing.iconPassed'));
            this.tooltip = new vscode.MarkdownString(
                `### 🟢 Connected Remote Instance\n\n` +
                `**Host:** \`${connection.host}\`\n\n` +
                `**Port:** \`${connection.port}\`\n\n` +
                `---\n_Remote instance_`
            );
        } else {
            this.description = 'remote';
            this.iconPath = new vscode.ThemeIcon('remote');
            this.tooltip = new vscode.MarkdownString(
                `### Remote Instance\n\n` +
                `**Host:** \`${connection.host}\`\n\n` +
                `**Port:** \`${connection.port}\`\n\n` +
                `---\n_Click to connect_`
            );
        }
        
        this.contextValue = isConnected ? 'rayforceRemoteConnected' : 'rayforceRemote';
        
        this.command = {
            command: 'rayforce.connectToRemote',
            title: 'Connect to Remote',
            arguments: [this]
        };
    }
}

export class RayforceInstancesProvider implements vscode.TreeDataProvider<InstanceItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<InstanceItem | undefined | null | void> = new vscode.EventEmitter<InstanceItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<InstanceItem | undefined | null | void> = this._onDidChangeTreeData.event;

    private _onProcessInfoChanged: vscode.EventEmitter<RayforceProcess | null> = new vscode.EventEmitter<RayforceProcess | null>();
    readonly onProcessInfoChanged: vscode.Event<RayforceProcess | null> = this._onProcessInfoChanged.event;

    private _onConnectionTypeChanged: vscode.EventEmitter<boolean> = new vscode.EventEmitter<boolean>();
    readonly onConnectionTypeChanged: vscode.Event<boolean> = this._onConnectionTypeChanged.event;

    private connectedPid: number | null = null;
    private connectedPort: number | null = null;
    private connectedHost: string | null = null;
    private connectedProcess: RayforceProcess | null = null;
    private isRemoteConnection: boolean = false;
    private statusBarItem: vscode.StatusBarItem;

    constructor(private context: vscode.ExtensionContext) {
        this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
        this.statusBarItem.command = 'rayforce.openRepl';
        context.subscriptions.push(this.statusBarItem);
    }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: InstanceItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: InstanceItem): Promise<InstanceItem[]> {
        if (element) { return []; }

        const items: InstanceItem[] = [];

        // Check actual connection status from REPL panel
        const isActuallyConnected = !this.isRemoteConnection && 
            this.connectedPid !== null && 
            this.connectedPort !== null;

        // Local processes only
        const processes = await this.findRayforceProcesses();
        for (const proc of processes.sort((a, b) => a.port - b.port)) {
            // Only mark as connected if REPL is actually connected to this instance
            const isConnected = isActuallyConnected && 
                this.connectedPid === proc.pid && 
                this.connectedPort === proc.port;
            items.push(new RayforceInstanceItem(
                proc,
                vscode.TreeItemCollapsibleState.None,
                isConnected
            ));
        }

        return items;
    }

    async getAvailableInstances(): Promise<{ label: string; host: string; port: number; isRemote: boolean }[]> {
        const instances: { label: string; host: string; port: number; isRemote: boolean }[] = [];

        const processes = await this.findRayforceProcesses();
        for (const proc of processes.sort((a, b) => a.port - b.port)) {
            instances.push({
                label: `localhost:${proc.port} (PID ${proc.pid})`,
                host: 'localhost',
                port: proc.port,
                isRemote: false
            });
        }
        
        return instances;
    }

    async findRayforceProcesses(): Promise<RayforceProcess[]> {
        return new Promise((resolve) => {
            // Use grep to only get rayforce processes directly
            cp.exec('ps aux | grep -E "[r]ayforce.*-p"', (error, stdout) => {
                if (error || !stdout.trim()) {
                    resolve([]);
                    return;
                }

                const processes: RayforceProcess[] = [];
                for (const line of stdout.split('\n')) {
                        const parts = line.trim().split(/\s+/);
                    if (parts.length < 11) {
                        continue;
                    }

                            const pid = parseInt(parts[1]);
                    if (isNaN(pid)) {
                        continue;
                    }

                    const cpu = parseFloat(parts[2]) || 0;
                    const memory = parseFloat(parts[3]) || 0;

                                const commandParts = parts.slice(10);
                    const fullCommand = commandParts[0] || '';
                    const executableName = path.basename(fullCommand).toLowerCase();
                    
                    if (executableName !== 'rayforce') {
                        continue;
                    }

                                const args = commandParts.slice(1).join(' ');
                    
                                const portMatch = args.match(/(?:-p|--port)\s+(\d+)/);
                    if (!portMatch) {
                        continue;
                    }

                    const port = parseInt(portMatch[1]);
                    if (isNaN(port) || port < 1 || port > 65535) {
                        continue;
                    }

                    processes.push({
                        pid,
                        command: path.basename(fullCommand),
                        args,
                        port,
                        cpu,
                        memory
                    });
                }
                resolve(processes);
            });
        });
    }

    async connectToInstance(item: RayforceInstanceItem): Promise<{ success: boolean; process?: RayforceProcess; host: string; port: number }> {
        if (!this.isRemoteConnection && this.connectedPid === item.process.pid) {
            return { success: true, process: item.process, host: 'localhost', port: item.process.port };
        }

            this.disconnectFromInstance();

        this.connectedPid = item.process.pid;
        this.connectedPort = item.process.port;
        this.connectedHost = 'localhost';
        this.connectedProcess = item.process;
        this.isRemoteConnection = false;

        this.statusBarItem.text = `$(vm-running) Rayforce: localhost:${this.connectedPort}`;
        this.statusBarItem.tooltip = `Connected to PID ${item.process.pid}\nClick to open REPL`;
        this.statusBarItem.show();

        this._onProcessInfoChanged.fire(item.process);
        this._onConnectionTypeChanged.fire(false);
        this.refresh();
        
        return { success: true, process: item.process, host: 'localhost', port: item.process.port };
    }

    async connectToRemote(item: RemoteInstanceItem): Promise<{ success: boolean; host: string; port: number }> {
        if (this.isRemoteConnection && 
            this.connectedHost === item.connection.host && 
            this.connectedPort === item.connection.port) {
            return { success: true, host: item.connection.host, port: item.connection.port };
        }

        this.disconnectFromInstance();

        this.connectedPid = null;
        this.connectedPort = item.connection.port;
        this.connectedHost = item.connection.host;
        this.connectedProcess = null;
        this.isRemoteConnection = true;

        this.statusBarItem.text = `$(remote) Rayforce: ${item.connection.host}:${this.connectedPort}`;
        this.statusBarItem.tooltip = `Connected to remote ${item.connection.host}:${item.connection.port}\nClick to open REPL`;
        this.statusBarItem.show();

        this._onProcessInfoChanged.fire(null);
        this._onConnectionTypeChanged.fire(true);
        this.refresh();
        
        return { success: true, host: item.connection.host, port: item.connection.port };
    }

    disconnectFromInstance(): void {
        if (this.connectedPort === null) return;

        this.connectedPid = null;
        this.connectedPort = null;
        this.connectedHost = null;
        this.connectedProcess = null;
        this.isRemoteConnection = false;
        this.statusBarItem.hide();
        
        this._onProcessInfoChanged.fire(null);
        this._onConnectionTypeChanged.fire(false);
        this.refresh();
    }

    getConnectedPort(): number | null {
        return this.connectedPort;
    }

    getConnectedHost(): string | null {
        return this.connectedHost;
    }

    getConnectedProcess(): RayforceProcess | null {
        return this.connectedProcess;
    }

    isConnectedRemote(): boolean {
        return this.isRemoteConnection;
        }

    setConnectionState(host: string | null, port: number | null, isRemote: boolean): void {
        this.connectedHost = host;
        this.connectedPort = port;
        this.isRemoteConnection = isRemote;
        if (host && port) {
            if (isRemote) {
                this.statusBarItem.text = `$(remote) Rayforce: ${host}:${port}`;
                this.statusBarItem.tooltip = `Connected to remote ${host}:${port}\nClick to open REPL`;
            } else {
                this.statusBarItem.text = `$(vm-running) Rayforce: ${host}:${port}`;
                this.statusBarItem.tooltip = `Connected to ${host}:${port}\nClick to open REPL`;
            }
            this.statusBarItem.show();
        } else {
            this.statusBarItem.hide();
        }
        this.refresh();
    }

    async terminateConnectedProcess(): Promise<boolean> {
        console.log('[Instances] terminateConnectedProcess called, PID:', this.connectedPid, 'isRemote:', this.isRemoteConnection);
        if (!this.connectedPid || this.isRemoteConnection) {
            console.log('[Instances] Cannot terminate - no PID or remote');
            return false;
        }
        
        const pid = this.connectedPid;
        console.log('[Instances] Killing PID:', pid);
        
        return new Promise((resolve) => {
            cp.exec(`kill -9 ${pid}`, (error, stdout, stderr) => {
                console.log('[Instances] kill result - error:', error, 'stdout:', stdout, 'stderr:', stderr);
                if (error) {
                    vscode.window.showErrorMessage(`Failed to terminate process: ${error.message}`);
                    resolve(false);
                } else {
                    vscode.window.showInformationMessage(`Process ${pid} terminated`);
                    this.disconnectFromInstance();
                    resolve(true);
                }
            });
        });
    }

    async updateProcessInfo(): Promise<void> {
        if (!this.connectedPid || this.isRemoteConnection) return;

        const processes = await this.findRayforceProcesses();
        const updated = processes.find(p => p.pid === this.connectedPid);
        
        if (updated) {
            this.connectedProcess = updated;
            this._onProcessInfoChanged.fire(updated);
        }
    }

    dispose(): void {
        this.statusBarItem.dispose();
    }
}

