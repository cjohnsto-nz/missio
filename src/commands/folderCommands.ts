import * as vscode from 'vscode';
import * as path from 'path';
import type { CommandContext } from './types';
import { RequestEditorProvider } from '../panels/requestPanel';
import { FolderEditorProvider } from '../panels/folderPanel';

export function registerFolderCommands(ctx: CommandContext): vscode.Disposable[] {
  const { collectionTreeProvider } = ctx;

  return [
    vscode.commands.registerCommand('missio.openFolder', async (nodeOrPath: any) => {
      const dirPath = typeof nodeOrPath === 'string' ? nodeOrPath : nodeOrPath?.dirPath;
      if (dirPath) {
        await FolderEditorProvider.open(dirPath);
      }
    }),

    vscode.commands.registerCommand('missio.newFolder', async (node: any) => {
      let parentDir: string | undefined;
      if (node?.dirPath) {
        parentDir = node.dirPath;
      } else if (node?.collection?.rootDir) {
        parentDir = node.collection.rootDir;
      }
      if (!parentDir) {
        vscode.window.showWarningMessage('Select a collection or folder first.');
        return;
      }
      const name = await vscode.window.showInputBox({ prompt: 'Folder name' });
      if (!name) return;
      const folderPath = path.join(parentDir, name);
      try {
        await vscode.workspace.fs.createDirectory(vscode.Uri.file(folderPath));
        vscode.window.showInformationMessage(`Created folder "${name}".`);
      } catch (e: any) {
        vscode.window.showErrorMessage(`Failed to create folder: ${e.message}`);
      }
    }),

    vscode.commands.registerCommand('missio.renameFolder', async (node: any) => {
      const dirPath = node?.dirPath;
      if (!dirPath) return;
      const currentName = path.basename(dirPath);
      const newName = await vscode.window.showInputBox({
        prompt: 'New folder name',
        value: currentName,
      });
      if (!newName || newName === currentName) return;
      const parentDir = path.dirname(dirPath);
      const newPath = path.join(parentDir, newName);

      // Collect open tabs whose files are under the old directory
      const oldDirLower = dirPath.toLowerCase() + path.sep;
      const affectedFiles: { oldPath: string; newPath: string }[] = [];
      const oldTabs: vscode.Tab[] = [];
      for (const group of vscode.window.tabGroups.all) {
        for (const tab of group.tabs) {
          const input = tab.input;
          if (input && typeof input === 'object' && 'uri' in input) {
            const tabPath = (input as { uri: vscode.Uri }).uri.fsPath;
            if (tabPath.toLowerCase().startsWith(oldDirLower)) {
              const relative = tabPath.substring(dirPath.length);
              affectedFiles.push({ oldPath: tabPath, newPath: newPath + relative });
              oldTabs.push(tab);
            }
          }
        }
      }

      // Save any dirty documents BEFORE the rename so changes go to the old (still valid) path
      for (const file of affectedFiles) {
        const doc = vscode.workspace.textDocuments.find(
          d => d.uri.fsPath.toLowerCase() === file.oldPath.toLowerCase(),
        );
        if (doc?.isDirty) {
          await doc.save();
        }
      }

      // Close old tabs before rename (files still exist, so no "save?" prompt)
      if (oldTabs.length > 0) {
        await vscode.window.tabGroups.close(oldTabs);
      }

      try {
        const fs = await import('fs');
        // Case-only rename on Windows needs a two-step rename (NTFS is case-insensitive)
        if (currentName.toLowerCase() === newName.toLowerCase()) {
          const tmpPath = dirPath + '_missio_tmp';
          fs.renameSync(dirPath, tmpPath);
          fs.renameSync(tmpPath, newPath);
        } else {
          fs.renameSync(dirPath, newPath);
        }

        // Update expanded state to match new paths, then refresh
        collectionTreeProvider.updateExpandedPath(dirPath, newPath);
        collectionTreeProvider.refresh();

        // Reopen affected editors at their new paths
        for (const file of affectedFiles) {
          await RequestEditorProvider.open(file.newPath);
        }

        vscode.window.showInformationMessage(`Renamed folder to "${newName}".`);
      } catch (e: any) {
        vscode.window.showErrorMessage(`Failed to rename folder: ${e.message}`);
      }
    }),

    vscode.commands.registerCommand('missio.deleteFolder', async (node: any) => {
      const dirPath = node?.dirPath;
      if (!dirPath) return;
      const name = path.basename(dirPath);
      const confirm = await vscode.window.showWarningMessage(
        `Delete folder "${name}" and all its contents? This cannot be undone.`,
        { modal: true },
        'Delete',
      );
      if (confirm !== 'Delete') return;
      try {
        await vscode.workspace.fs.delete(vscode.Uri.file(dirPath), { recursive: true });
        vscode.window.showInformationMessage(`Deleted folder "${name}".`);
      } catch (e: any) {
        vscode.window.showErrorMessage(`Failed to delete folder: ${e.message}`);
      }
    }),
  ];
}
