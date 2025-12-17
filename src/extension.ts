import * as vscode from 'vscode';
import { RayforceInstancesProvider, RayforceInstanceItem, RemoteInstanceItem, RayforceProcess, InstanceItem } from './instancesProvider';
import { RayforceReplPanel } from './replPanel';
import { ProcessInfoProvider } from './processInfoProvider';

let instancesProvider: RayforceInstancesProvider;
let processInfoProvider: ProcessInfoProvider;

export async function activate(context: vscode.ExtensionContext) {
    instancesProvider = new RayforceInstancesProvider(context);
    processInfoProvider = new ProcessInfoProvider(context.extensionUri);

    const treeView = vscode.window.createTreeView('rayforceInstances', {
        treeDataProvider: instancesProvider,
        showCollapseAll: false
    });

    const processInfoView = vscode.window.registerWebviewViewProvider(
        'rayforceProcessInfo',
        processInfoProvider
    );

    instancesProvider.onProcessInfoChanged((process: RayforceProcess | null) => {
        processInfoProvider.updateProcess(process);
    });

    instancesProvider.onConnectionTypeChanged((isRemote: boolean) => {
        processInfoProvider.setIsRemote(isRemote);
    });

    processInfoProvider.setOnTerminate(async () => {
        await instancesProvider.terminateConnectedProcess();
        if (RayforceReplPanel.currentPanel) {
            RayforceReplPanel.currentPanel.disconnect();
        }
    });

    const refreshCommand = vscode.commands.registerCommand('rayforce.refreshInstances', () => {
        instancesProvider.refresh();
        instancesProvider.updateProcessInfo();
    });

    const connectCommand = vscode.commands.registerCommand(
        'rayforce.connectToInstance',
        async (item: RayforceInstanceItem) => {
            const result = await instancesProvider.connectToInstance(item);
            if (result.success) {
                const panel = RayforceReplPanel.createOrShow(context.extensionUri);
                try {
                    await panel.connect(result.host, result.port);
                } catch (err) {}
            }
        }
    );

    const connectRemoteCommand = vscode.commands.registerCommand(
        'rayforce.connectToRemote',
        async (item: RemoteInstanceItem) => {
            const result = await instancesProvider.connectToRemote(item);
            if (result.success) {
                const panel = RayforceReplPanel.createOrShow(context.extensionUri);
                try {
                    await panel.connect(result.host, result.port);
                } catch (err) {}
            }
        }
    );

    const addRemoteCommand = vscode.commands.registerCommand('rayforce.addRemote', async () => {
        const input = await vscode.window.showInputBox({
            prompt: 'Enter remote host:port (e.g., 192.168.1.100:5111)',
            placeHolder: 'host:port',
            validateInput: (value) => {
                const match = value.match(/^([^:]+):(\d+)$/);
                if (!match) return 'Format: host:port (e.g., 192.168.1.100:5111)';
                const port = parseInt(match[2]);
                if (port < 1 || port > 65535) return 'Port must be between 1 and 65535';
                return null;
            }
        });
        
        if (input) {
            const [host, portStr] = input.split(':');
            await instancesProvider.addRemoteConnection(host, parseInt(portStr));
        }
    });

    const removeRemoteCommand = vscode.commands.registerCommand(
        'rayforce.removeRemote',
        async (item: RemoteInstanceItem) => {
            await instancesProvider.removeRemoteConnection(item.connection.host, item.connection.port);
        }
    );

    const disconnectCommand = vscode.commands.registerCommand('rayforce.disconnectFromInstance', () => {
        instancesProvider.disconnectFromInstance();
        if (RayforceReplPanel.currentPanel) {
            RayforceReplPanel.currentPanel.disconnect();
        }
    });

    const openReplCommand = vscode.commands.registerCommand(
        'rayforce.openRepl',
        async (item?: InstanceItem) => {
            const panel = RayforceReplPanel.createOrShow(context.extensionUri);
            
            if (item) {
                if (item instanceof RayforceInstanceItem) {
                    try { await panel.connect('localhost', item.process.port); } catch {}
                } else if (item instanceof RemoteInstanceItem) {
                    try { await panel.connect(item.connection.host, item.connection.port); } catch {}
                }
            } else {
                const host = instancesProvider.getConnectedHost();
                const port = instancesProvider.getConnectedPort();
                if (host && port && !panel.isConnected()) {
                    try { await panel.connect(host, port); } catch {}
                }
            }
        }
    );

    context.subscriptions.push(
        treeView,
        processInfoView,
        refreshCommand,
        connectCommand,
        connectRemoteCommand,
        addRemoteCommand,
        removeRemoteCommand,
        disconnectCommand,
        openReplCommand
    );

    const refreshInterval = setInterval(() => {
        instancesProvider.refresh();
        instancesProvider.updateProcessInfo();
    }, 3000);

    context.subscriptions.push({ dispose: () => clearInterval(refreshInterval) });
}

/**
 * Deactivate the extension
 */
export function deactivate() {
    if (instancesProvider) {
        instancesProvider.dispose();
    }
}
