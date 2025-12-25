import * as vscode from 'vscode';
import { RemoteConnection, RemoteInstanceItem } from './instancesProvider';

export interface SavedInstance {
    id: string;
    host: string;
    port: number;
    folderId: string | null; // null means root level
}

export interface SavedFolder {
    id: string;
    name: string;
    parentId: string | null; // null means root level
    isExpanded: boolean;
}

export type SavedInstanceItem = SavedInstanceTreeItem | SavedFolderTreeItem;

export class SavedInstanceTreeItem extends vscode.TreeItem {
    public readonly isFolder = false;
    
    constructor(
        public readonly instance: SavedInstance,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly isConnected: boolean = false
    ) {
        super(`${instance.host}:${instance.port}`, collapsibleState);
        
        if (isConnected) {
            this.description = '● connected';
            this.iconPath = new vscode.ThemeIcon('vm-running', new vscode.ThemeColor('testing.iconPassed'));
            this.tooltip = new vscode.MarkdownString(
                `### 🟢 Connected Instance\n\n` +
                `**Host:** \`${instance.host}\`\n\n` +
                `**Port:** \`${instance.port}\`\n\n` +
                `---\n_Click to reconnect or use context menu_`
            );
            // Make connected instance more prominent
            this.resourceUri = vscode.Uri.parse(`rayforce://connected/${instance.host}:${instance.port}`);
        } else {
            this.description = '';
            this.iconPath = new vscode.ThemeIcon('vm-outline');
            this.tooltip = new vscode.MarkdownString(
                `### Instance\n\n` +
                `**Host:** \`${instance.host}\`\n\n` +
                `**Port:** \`${instance.port}\`\n\n` +
                `---\n_Click to connect_`
            );
        }
        
        this.contextValue = isConnected ? 'savedInstanceConnected' : 'savedInstance';
        
        this.command = {
            command: 'rayforce.connectToSavedInstance',
            title: 'Connect to Instance',
            arguments: [this]
        };
    }
}

export class SavedFolderTreeItem extends vscode.TreeItem {
    public readonly isFolder = true;
    
    constructor(
        public readonly folder: SavedFolder,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState
    ) {
        super(folder.name, collapsibleState);
        
        this.description = '';
        this.iconPath = new vscode.ThemeIcon('folder');
        this.tooltip = new vscode.MarkdownString(
            `### Folder\n\n` +
            `**Name:** \`${folder.name}\`\n\n` +
            `---\n_Right-click for options_`
        );
        
        this.contextValue = 'savedFolder';
    }
}

interface SavedInstancesData {
    instances: SavedInstance[];
    folders: SavedFolder[];
    expandedFolders: Set<string>; // Track expanded folder IDs
}

const MIME_TYPE_INSTANCE = 'application/vnd.code.tree.rayforceSavedInstances.instance';
const MIME_TYPE_FOLDER = 'application/vnd.code.tree.rayforceSavedInstances.folder';

class SavedInstancesDragAndDropController implements vscode.TreeDragAndDropController<SavedInstanceItem> {
    dragMimeTypes: string[] = [MIME_TYPE_INSTANCE, MIME_TYPE_FOLDER];
    dropMimeTypes: string[] = [MIME_TYPE_INSTANCE, MIME_TYPE_FOLDER];

    constructor(private provider: SavedInstancesProvider) {}

    async handleDrag(
        source: readonly SavedInstanceItem[],
        dataTransfer: vscode.DataTransfer,
        token: vscode.CancellationToken
    ): Promise<void> {
        if (source.length === 0) return;

        const items: Array<{ type: 'instance' | 'folder'; id: string }> = [];
        for (const item of source) {
            if (item.isFolder) {
                items.push({ type: 'folder', id: (item as SavedFolderTreeItem).folder.id });
            } else {
                items.push({ type: 'instance', id: (item as SavedInstanceTreeItem).instance.id });
            }
        }

        const data = new vscode.DataTransferItem(JSON.stringify(items));
        if (source[0].isFolder) {
            dataTransfer.set(MIME_TYPE_FOLDER, data);
        } else {
            dataTransfer.set(MIME_TYPE_INSTANCE, data);
        }
    }

    async handleDrop(
        target: SavedInstanceItem | undefined,
        dataTransfer: vscode.DataTransfer,
        token: vscode.CancellationToken
    ): Promise<void> {
        const transferItemInstance = dataTransfer.get(MIME_TYPE_INSTANCE);
        const transferItemFolder = dataTransfer.get(MIME_TYPE_FOLDER);

        if (!transferItemInstance && !transferItemFolder) return;

        const transferItem = transferItemInstance || transferItemFolder;
        if (!transferItem) return;

        const items: Array<{ type: 'instance' | 'folder'; id: string }> = JSON.parse(await transferItem.asString());

        // Determine target folder
        let targetFolderId: string | null = null;
        if (target && target.isFolder) {
            targetFolderId = (target as SavedFolderTreeItem).folder.id;
        } else {
            // Dropping on root or instance - move to root level
            targetFolderId = null;
        }

        // Prevent dropping folder into itself or its children
        const data = this.provider.getData();
        const getAllDescendantFolders = (folderId: string): string[] => {
            const descendants: string[] = [];
            const children = data.folders.filter(f => f.parentId === folderId);
            for (const child of children) {
                descendants.push(child.id);
                descendants.push(...getAllDescendantFolders(child.id));
            }
            return descendants;
        };

        for (const item of items) {
            if (item.type === 'folder') {
                // Prevent dropping folder into itself or its descendants
                if (targetFolderId === item.id || getAllDescendantFolders(item.id).includes(targetFolderId || '')) {
                    continue;
                }
                await this.provider.moveFolderToFolder(item.id, targetFolderId);
            } else {
                await this.provider.moveInstanceToFolder(item.id, targetFolderId);
            }
        }
    }
}

export class SavedInstancesProvider implements vscode.TreeDataProvider<SavedInstanceItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<SavedInstanceItem | undefined | null | void> = new vscode.EventEmitter<SavedInstanceItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<SavedInstanceItem | undefined | null | void> = this._onDidChangeTreeData.event;

    private _onConnectionTypeChanged: vscode.EventEmitter<boolean> = new vscode.EventEmitter<boolean>();
    readonly onConnectionTypeChanged: vscode.Event<boolean> = this._onConnectionTypeChanged.event;

    private connectedHost: string | null = null;
    private connectedPort: number | null = null;
    private isRemoteConnection: boolean = false;

    constructor(private context: vscode.ExtensionContext) {
        // Load expanded state from storage
        this.loadExpandedState();
    }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: SavedInstanceItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: SavedInstanceItem): Promise<SavedInstanceItem[]> {
        const data = this.getData();
        
        if (!element) {
            // Root level - show folders and instances without parent
            const items: SavedInstanceItem[] = [];
            
            // Add root folders
            const rootFolders = data.folders.filter(f => f.parentId === null);
            for (const folder of rootFolders.sort((a, b) => a.name.localeCompare(b.name))) {
                const isExpanded = data.expandedFolders.has(folder.id);
                items.push(new SavedFolderTreeItem(
                    folder,
                    isExpanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed
                ));
            }
            
            // Add root instances (no indent for root level)
            const rootInstances = data.instances.filter(i => i.folderId === null);
            for (const instance of rootInstances.sort((a, b) => {
                if (a.host !== b.host) return a.host.localeCompare(b.host);
                return a.port - b.port;
            })) {
                // Only mark as connected if actually connected and matches
                const isConnected = this.isRemoteConnection && 
                    this.connectedHost === instance.host && 
                    this.connectedPort === instance.port;
                items.push(new SavedInstanceTreeItem(
                    instance,
                    vscode.TreeItemCollapsibleState.None,
                    isConnected
                ));
            }
            
            return items;
        }
        
        if (element.isFolder) {
            // Folder children - show subfolders and instances in this folder
            const folder = (element as SavedFolderTreeItem).folder;
            const items: SavedInstanceItem[] = [];
            
            // Add subfolders
            const subFolders = data.folders.filter(f => f.parentId === folder.id);
            for (const subFolder of subFolders.sort((a, b) => a.name.localeCompare(b.name))) {
                const isExpanded = data.expandedFolders.has(subFolder.id);
                const folderItem = new SavedFolderTreeItem(
                    subFolder,
                    isExpanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed
                );
                // Add visual indent for items inside folders
                folderItem.label = `  ${folderItem.label}`;
                items.push(folderItem);
            }
            
            // Add instances in this folder
            const folderInstances = data.instances.filter(i => i.folderId === folder.id);
            for (const instance of folderInstances.sort((a, b) => {
                if (a.host !== b.host) return a.host.localeCompare(b.host);
                return a.port - b.port;
            })) {
                // Only mark as connected if actually connected and matches
                const isConnected = this.isRemoteConnection && 
                    this.connectedHost === instance.host && 
                    this.connectedPort === instance.port;
                const instanceItem = new SavedInstanceTreeItem(
                    instance,
                    vscode.TreeItemCollapsibleState.None,
                    isConnected
                );
                // Add visual indent for items inside folders
                instanceItem.label = `  ${instanceItem.label}`;
                items.push(instanceItem);
            }
            
            return items;
        }
        
        return [];
    }

    getData(): SavedInstancesData {
        const instances = this.context.globalState.get<SavedInstance[]>('rayforce.savedInstances', []);
        const folders = this.context.globalState.get<SavedFolder[]>('rayforce.savedFolders', []);
        const expandedFolders = this.loadExpandedState();
        
        return { instances, folders, expandedFolders };
    }

    private async saveData(data: SavedInstancesData): Promise<void> {
        await this.context.globalState.update('rayforce.savedInstances', data.instances);
        await this.context.globalState.update('rayforce.savedFolders', data.folders);
        await this.saveExpandedState(data.expandedFolders);
    }

    private loadExpandedState(): Set<string> {
        const expanded = this.context.globalState.get<string[]>('rayforce.expandedFolders', []);
        return new Set(expanded);
    }

    private async saveExpandedState(expanded: Set<string>): Promise<void> {
        await this.context.globalState.update('rayforce.expandedFolders', Array.from(expanded));
    }

    async toggleFolderExpansion(folderId: string): Promise<void> {
        const data = this.getData();
        if (data.expandedFolders.has(folderId)) {
            data.expandedFolders.delete(folderId);
        } else {
            data.expandedFolders.add(folderId);
        }
        await this.saveExpandedState(data.expandedFolders);
        this.refresh();
    }

    async createFolder(name: string, parentId: string | null = null): Promise<string> {
        const data = this.getData();
        const folderId = `folder_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const folder: SavedFolder = {
            id: folderId,
            name,
            parentId,
            isExpanded: false
        };
        data.folders.push(folder);
        await this.saveData(data);
        this.refresh();
        return folderId;
    }

    async renameFolder(folderId: string, newName: string): Promise<void> {
        const data = this.getData();
        const folder = data.folders.find(f => f.id === folderId);
        if (folder) {
            folder.name = newName;
            await this.saveData(data);
            this.refresh();
        }
    }

    async deleteFolder(folderId: string): Promise<void> {
        const data = this.getData();
        
        // Get all subfolders recursively
        const getAllSubfolders = (parentId: string | null): string[] => {
            const subfolders: string[] = [];
            const directSubfolders = data.folders.filter(f => f.parentId === parentId);
            for (const subfolder of directSubfolders) {
                subfolders.push(subfolder.id);
                subfolders.push(...getAllSubfolders(subfolder.id));
            }
            return subfolders;
        };
        
        const allFolderIds = [folderId, ...getAllSubfolders(folderId)];
        
        // Delete all instances in these folders
        data.instances = data.instances.filter(i => !allFolderIds.includes(i.folderId || ''));
        
        // Delete all folders
        data.folders = data.folders.filter(f => !allFolderIds.includes(f.id));
        
        // Remove from expanded state
        for (const id of allFolderIds) {
            data.expandedFolders.delete(id);
        }
        
        await this.saveData(data);
        this.refresh();
    }

    async addInstance(host: string, port: number, folderId: string | null = null): Promise<void> {
        const data = this.getData();
        const instanceId = `instance_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        
        // Check if instance already exists
        if (data.instances.find(i => i.host === host && i.port === port)) {
            return;
        }
        
        const instance: SavedInstance = {
            id: instanceId,
            host,
            port,
            folderId
        };
        data.instances.push(instance);
        await this.saveData(data);
        this.refresh();
    }

    async removeInstance(instanceId: string): Promise<void> {
        const data = this.getData();
        data.instances = data.instances.filter(i => i.id !== instanceId);
        await this.saveData(data);
        this.refresh();
    }

    async moveInstanceToFolder(instanceId: string, folderId: string | null): Promise<void> {
        const data = this.getData();
        const instance = data.instances.find(i => i.id === instanceId);
        if (instance) {
            instance.folderId = folderId;
            await this.saveData(data);
            this.refresh();
        }
    }

    async moveFolderToFolder(folderId: string, targetFolderId: string | null): Promise<void> {
        const data = this.getData();
        const folder = data.folders.find(f => f.id === folderId);
        if (folder) {
            // Prevent moving folder into itself
            if (targetFolderId === folderId) {
                return;
            }
            // Prevent moving folder into its descendants
            const getAllDescendantFolders = (parentId: string): string[] => {
                const descendants: string[] = [];
                const children = data.folders.filter(f => f.parentId === parentId);
                for (const child of children) {
                    descendants.push(child.id);
                    descendants.push(...getAllDescendantFolders(child.id));
                }
                return descendants;
            };
            if (targetFolderId && getAllDescendantFolders(folderId).includes(targetFolderId)) {
                return;
            }
            folder.parentId = targetFolderId;
            await this.saveData(data);
            this.refresh();
        }
    }


    async connectToInstance(item: SavedInstanceTreeItem): Promise<{ success: boolean; host: string; port: number }> {
        if (this.isRemoteConnection && 
            this.connectedHost === item.instance.host && 
            this.connectedPort === item.instance.port) {
            return { success: true, host: item.instance.host, port: item.instance.port };
        }

        this.connectedPort = item.instance.port;
        this.connectedHost = item.instance.host;
        this.isRemoteConnection = true;

        this._onConnectionTypeChanged.fire(true);
        this.refresh();
        
        return { success: true, host: item.instance.host, port: item.instance.port };
    }

    disconnectFromInstance(): void {
        if (this.connectedPort === null) return;

        this.connectedPort = null;
        this.connectedHost = null;
        this.isRemoteConnection = false;
        
        this._onConnectionTypeChanged.fire(false);
        this.refresh();
    }

    getConnectedPort(): number | null {
        return this.connectedPort;
    }

    getConnectedHost(): string | null {
        return this.connectedHost;
    }

    isConnectedRemote(): boolean {
        return this.isRemoteConnection;
    }

    setConnectionState(host: string | null, port: number | null, isRemote: boolean): void {
        this.connectedHost = host;
        this.connectedPort = port;
        this.isRemoteConnection = isRemote;
        this.refresh();
    }

    getAllFolders(): SavedFolder[] {
        return this.getData().folders;
    }

    getAllInstances(): SavedInstance[] {
        return this.getData().instances;
    }

    getDragAndDropController(): SavedInstancesDragAndDropController {
        return new SavedInstancesDragAndDropController(this);
    }
}



