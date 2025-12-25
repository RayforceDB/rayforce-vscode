import * as vscode from 'vscode';
import { RayforceInstancesProvider, RayforceInstanceItem, RemoteInstanceItem, RayforceProcess, InstanceItem } from './instancesProvider';
import { SavedInstancesProvider, SavedInstanceTreeItem, SavedFolderTreeItem, SavedInstance, SavedFolder } from './savedInstancesProvider';
import { RayforceReplPanel } from './replPanel';
import { ProcessInfoProvider } from './processInfoProvider';
import { RayforceCompletionProvider } from './completionProvider';

let instancesProvider: RayforceInstancesProvider;
let savedInstancesProvider: SavedInstancesProvider;
let processInfoProvider: ProcessInfoProvider;

export async function activate(context: vscode.ExtensionContext) {
    instancesProvider = new RayforceInstancesProvider(context);
    savedInstancesProvider = new SavedInstancesProvider(context);
    processInfoProvider = new ProcessInfoProvider(context.extensionUri);

    const treeView = vscode.window.createTreeView('rayforceInstances', {
        treeDataProvider: instancesProvider,
        showCollapseAll: false
    });

    const savedTreeView = vscode.window.createTreeView('rayforceSavedInstances', {
        treeDataProvider: savedInstancesProvider,
        dragAndDropController: savedInstancesProvider.getDragAndDropController(),
        showCollapseAll: false
    });

    // Handle folder expand/collapse
    savedTreeView.onDidExpandElement(e => {
        if (e.element.isFolder) {
            const folder = (e.element as SavedFolderTreeItem).folder;
            savedInstancesProvider.toggleFolderExpansion(folder.id);
        }
    });

    savedTreeView.onDidCollapseElement(e => {
        if (e.element.isFolder) {
            const folder = (e.element as SavedFolderTreeItem).folder;
            savedInstancesProvider.toggleFolderExpansion(folder.id);
        }
    });

    const processInfoView = vscode.window.registerWebviewViewProvider(
        'rayforceProcessInfo',
        processInfoProvider
    );

    // Update process info provider when connection changes
    const updateProcessInfo = () => {
        if (RayforceReplPanel.currentPanel && RayforceReplPanel.currentPanel.isConnected()) {
            const replHost = RayforceReplPanel.currentPanel.getHost();
            const replPort = RayforceReplPanel.currentPanel.getPort();
            if (replHost && replPort) {
                const isRemote = replHost !== 'localhost';
                processInfoProvider.updateConnectedInstance(replHost, replPort, isRemote);
            } else {
                processInfoProvider.updateConnectedInstance(null, null, false);
            }
        } else {
            processInfoProvider.updateConnectedInstance(null, null, false);
        }
    };

    // Helper function to check actual connection status from REPL panel
    const checkActualConnection = async () => {
        if (RayforceReplPanel.currentPanel && RayforceReplPanel.currentPanel.isConnected()) {
            const replHost = RayforceReplPanel.currentPanel.getHost();
            const replPort = RayforceReplPanel.currentPanel.getPort();
            if (replHost && replPort) {
                if (replHost === 'localhost') {
                    // For localhost, find the process and set connection state
                    const processes = await instancesProvider.findRayforceProcesses();
                    const proc = processes.find(p => p.port === replPort);
                    if (proc) {
                        instancesProvider.setConnectionState(replHost, replPort, false);
                        // Update connected PID manually
                        (instancesProvider as any).connectedPid = proc.pid;
                        (instancesProvider as any).connectedProcess = proc;
                    }
                    savedInstancesProvider.setConnectionState(null, null, false);
                } else {
                    instancesProvider.setConnectionState(replHost, replPort, true);
                    savedInstancesProvider.setConnectionState(replHost, replPort, true);
                }
            }
        } else {
            // No actual connection, clear states
            instancesProvider.setConnectionState(null, null, false);
            savedInstancesProvider.setConnectionState(null, null, false);
        }
        instancesProvider.refresh();
        savedInstancesProvider.refresh();
        updateProcessInfo();
    };

    instancesProvider.onConnectionTypeChanged((isRemote: boolean) => {
        checkActualConnection();
        updateProcessInfo();
    });

    savedInstancesProvider.onConnectionTypeChanged((isRemote: boolean) => {
        checkActualConnection();
        updateProcessInfo();
    });

    // Check connection status periodically (less frequently)
    const connectionCheckInterval = setInterval(() => {
        checkActualConnection();
    }, 60000); // 1 minute - same as instances refresh

    // Update process info on initial load
    updateProcessInfo();

    const refreshCommand = vscode.commands.registerCommand('rayforce.refreshInstances', () => {
        instancesProvider.refresh();
        updateProcessInfo();
    });

    const connectCommand = vscode.commands.registerCommand(
        'rayforce.connectToInstance',
        async (item: RayforceInstanceItem) => {
            // Guard against invalid arguments (use property check since instanceof fails after serialization)
            if (!item || !item.process || typeof item.process.port !== 'number') {
                return;
            }
            const result = await instancesProvider.connectToInstance(item);
            if (result.success) {
                const panel = RayforceReplPanel.createOrShow(context.extensionUri);
                try {
                    await panel.connect(result.host, result.port);
                    setTimeout(() => {
                        checkActualConnection();
                        updateProcessInfo();
                    }, 500);
                } catch (err) {}
            }
        }
    );

    const connectSavedInstanceCommand = vscode.commands.registerCommand(
        'rayforce.connectToSavedInstance',
        async (item: SavedInstanceTreeItem) => {
            if (!item || !item.instance || typeof item.instance.port !== 'number') {
                return;
            }
            const result = await savedInstancesProvider.connectToInstance(item);
            if (result.success) {
                // Sync to instances provider
                instancesProvider.setConnectionState(result.host, result.port, true);
                const panel = RayforceReplPanel.createOrShow(context.extensionUri);
                try {
                    await panel.connect(result.host, result.port);
                    setTimeout(() => {
                        checkActualConnection();
                        updateProcessInfo();
                    }, 500);
                } catch (err) {}
            }
        }
    );

    const addSavedInstanceCommand = vscode.commands.registerCommand('rayforce.addSavedInstance', async (folderId?: string | null) => {
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
            // Explicitly pass null if folderId is undefined to save to root
            await savedInstancesProvider.addInstance(host, parseInt(portStr), folderId !== undefined ? folderId : null);
        }
    });

    const removeSavedInstanceCommand = vscode.commands.registerCommand(
        'rayforce.removeSavedInstance',
        async (item: SavedInstanceTreeItem) => {
            await savedInstancesProvider.removeInstance(item.instance.id);
        }
    );

    const createFolderCommand = vscode.commands.registerCommand('rayforce.createFolder', async (parentFolder?: SavedFolderTreeItem) => {
        const name = await vscode.window.showInputBox({
            prompt: 'Enter folder name',
            placeHolder: 'Folder name',
            validateInput: (value) => {
                if (!value || !value.trim()) return 'Folder name cannot be empty';
                return null;
            }
        });
        
        if (name) {
            const parentId = parentFolder ? parentFolder.folder.id : null;
            const folderId = await savedInstancesProvider.createFolder(name.trim(), parentId);
            // Keep parent folder selected after creating subfolder
            if (parentFolder) {
                setTimeout(() => {
                    savedTreeView.reveal(parentFolder, { select: true, focus: false });
                }, 100);
            }
        }
    });

    const renameFolderCommand = vscode.commands.registerCommand(
        'rayforce.renameFolder',
        async (item: SavedFolderTreeItem) => {
            const newName = await vscode.window.showInputBox({
                prompt: 'Enter new folder name',
                value: item.folder.name,
                validateInput: (value) => {
                    if (!value || !value.trim()) return 'Folder name cannot be empty';
                    return null;
        }
    });

            if (newName) {
                await savedInstancesProvider.renameFolder(item.folder.id, newName.trim());
                // Keep folder selected after renaming
                setTimeout(() => {
                    savedTreeView.reveal(item, { select: true, focus: false });
                }, 100);
            }
        }
    );

    const deleteFolderCommand = vscode.commands.registerCommand(
        'rayforce.deleteFolder',
        async (item: SavedFolderTreeItem) => {
            const confirm = await vscode.window.showWarningMessage(
                `Delete folder "${item.folder.name}" and all its contents?`,
                { modal: true },
                'Delete'
            );
            
            if (confirm === 'Delete') {
                await savedInstancesProvider.deleteFolder(item.folder.id);
            }
        }
    );

    const saveInstanceToFolderCommand = vscode.commands.registerCommand(
        'rayforce.saveInstanceToFolder',
        async (item?: SavedInstanceTreeItem | RayforceInstanceItem | SavedFolderTreeItem) => {
            // Check if item is a folder - if so, use it as target folder
            let targetFolderId: string | null = null;
            let folderItem: SavedFolderTreeItem | null = null;
            
            if (item && 'isFolder' in item && item.isFolder) {
                folderItem = item as SavedFolderTreeItem;
                targetFolderId = folderItem.folder.id;
            }
            
            let instance: { host: string; port: number; id?: string } | null = null;
            
            // If item is a folder, we need to ask for instance
            if (folderItem) {
                // Ask user to input instance
                const input = await vscode.window.showInputBox({
                    prompt: `Enter remote host:port to save to folder "${folderItem.folder.name}"`,
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
                    instance = { host, port: parseInt(portStr) };
                } else {
                    return; // User cancelled
                }
            } else if (item && 'instance' in item) {
                // Saved instance - move to folder
                instance = { host: item.instance.host, port: item.instance.port, id: item.instance.id };
            } else if (item && 'process' in item) {
                // Local instance - convert to saved
                instance = { host: 'localhost', port: item.process.port };
            } else {
                // Ask user to input
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
                    instance = { host, port: parseInt(portStr) };
                } else {
                    return; // User cancelled
                }
            }
            
            if (!instance) return;
            
            // If target folder is already determined (from context menu), use it directly
            if (targetFolderId !== null) {
                if (instance.id) {
                    // Move existing instance
                    await savedInstancesProvider.moveInstanceToFolder(instance.id, targetFolderId);
                } else {
                    // Add new instance
                    await savedInstancesProvider.addInstance(instance.host, instance.port, targetFolderId);
                }
                // Keep folder selected after operation
                if (folderItem) {
                    setTimeout(() => {
                        savedTreeView.reveal(folderItem!, { select: true, focus: false });
                    }, 100);
                }
                return;
            }
            
            // Show folder picker only if folder wasn't specified
            const folders = savedInstancesProvider.getAllFolders();
            const folderOptions: vscode.QuickPickItem[] = [
                { label: '$(folder) Root level', description: 'Save to root' }
            ];
            
            const buildFolderOptions = (parentId: string | null, indent: string = ''): void => {
                const children = folders.filter(f => f.parentId === parentId);
                for (const folder of children.sort((a, b) => a.name.localeCompare(b.name))) {
                    folderOptions.push({
                        label: `${indent}${folder.name}`,
                        description: 'Folder'
                    });
                    buildFolderOptions(folder.id, indent + '    ');
                }
            };
            
            buildFolderOptions(null);
            
            const selected = await vscode.window.showQuickPick(folderOptions, {
                placeHolder: 'Select folder to save instance'
            });
            
            if (selected) {
                let selectedFolderId: string | null = null;
                if (selected.label !== '$(folder) Root level') {
                    const folderName = selected.label.trim();
                    const folder = folders.find(f => f.name === folderName);
                    if (folder) {
                        selectedFolderId = folder.id;
                    }
                }
                
                if (instance.id) {
                    // Move existing instance
                    await savedInstancesProvider.moveInstanceToFolder(instance.id, selectedFolderId);
                } else {
                    // Add new instance
                    await savedInstancesProvider.addInstance(instance.host, instance.port, selectedFolderId);
                }
            }
        }
    );

    const disconnectCommand = vscode.commands.registerCommand('rayforce.disconnectFromInstance', () => {
        instancesProvider.disconnectFromInstance();
        savedInstancesProvider.disconnectFromInstance();
        if (RayforceReplPanel.currentPanel) {
            RayforceReplPanel.currentPanel.disconnect();
        }
        updateProcessInfo();
    });

    const openReplCommand = vscode.commands.registerCommand(
        'rayforce.openRepl',
        async (item?: InstanceItem) => {
            const panel = RayforceReplPanel.createOrShow(context.extensionUri);
            
            // Use property checks instead of instanceof (fails after serialization)
            const asLocal = item as RayforceInstanceItem | undefined;
            const asRemote = item as RemoteInstanceItem | undefined;
            
            if (asLocal?.process && typeof asLocal.process.port === 'number') {
                try { await panel.connect('localhost', asLocal.process.port); } catch {}
            } else if (!item) {
                // Try saved instances first, then regular instances
                let host = savedInstancesProvider.getConnectedHost();
                let port = savedInstancesProvider.getConnectedPort();
                if (!host || !port) {
                    host = instancesProvider.getConnectedHost();
                    port = instancesProvider.getConnectedPort();
                }
                if (host && port && !panel.isConnected()) {
                    try { await panel.connect(host, port); } catch {}
                }
            }
        }
    );

    const executeSelectionCommand = vscode.commands.registerCommand(
        'rayforce.executeSelection',
        async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showWarningMessage('No active editor');
                return;
            }

            const selection = editor.selection;
            const text = selection.isEmpty 
                ? editor.document.lineAt(selection.active.line).text
                : editor.document.getText(selection);

            if (!text.trim()) {
                vscode.window.showWarningMessage('No text selected');
                return;
            }

            const instances = await instancesProvider.getAvailableInstances();
            const savedInstances = savedInstancesProvider.getAllInstances();
            
            const allInstances: { label: string; host: string; port: number; isRemote: boolean }[] = [...instances];
            for (const saved of savedInstances) {
                allInstances.push({
                    label: `${saved.host}:${saved.port} (saved)`,
                    host: saved.host,
                    port: saved.port,
                    isRemote: true
                });
            }
            
            if (allInstances.length === 0) {
                vscode.window.showWarningMessage('No Rayforce instances available');
                return;
            }

            const selected = await vscode.window.showQuickPick(
                allInstances.map(i => ({ label: i.label, instance: i })),
                { placeHolder: 'Select Rayforce instance to execute on' }
            );

            if (!selected) return;

            const panel = RayforceReplPanel.createOrShow(context.extensionUri);
            try {
                await panel.connect(selected.instance.host, selected.instance.port);
                await panel.execute(text.trim());
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                vscode.window.showErrorMessage(`Failed to execute: ${message}`);
            }
        }
    );

    // Register completion provider for Rayfall files
    const completionProvider = vscode.languages.registerCompletionItemProvider(
        { language: 'rayfall' },
        new RayforceCompletionProvider(),
        '(', "'", ' '  // Trigger on (, ', and space
    );

    context.subscriptions.push(
        treeView,
        savedTreeView,
        processInfoView,
        refreshCommand,
        connectCommand,
        connectSavedInstanceCommand,
        addSavedInstanceCommand,
        removeSavedInstanceCommand,
        createFolderCommand,
        renameFolderCommand,
        deleteFolderCommand,
        saveInstanceToFolderCommand,
        disconnectCommand,
        openReplCommand,
        executeSelectionCommand,
        completionProvider
    );

    // Refresh instances once on startup
    instancesProvider.refresh();

    // Then refresh once per minute
    const refreshInterval = setInterval(() => {
        instancesProvider.refresh();
        instancesProvider.updateProcessInfo();
    }, 60000); // 1 minute

    context.subscriptions.push(
        { dispose: () => clearInterval(refreshInterval) },
        { dispose: () => clearInterval(connectionCheckInterval) }
    );
}

/**
 * Deactivate the extension
 */
export function deactivate() {
    if (instancesProvider) {
        instancesProvider.dispose();
    }
}
