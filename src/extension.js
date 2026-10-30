'use strict';

const vscode = require('vscode');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { relativeInside, isWithinScope, classifyChange } = require('./core');
const { taskFormHtml } = require('./taskForm');
const { copilotAgentOptions } = require('./handoff');
const { mergeObserved, observedCount } = require('./executionHistory');
const { ICONS, emojiSvg, customFileName, buildTheme } = require('./rootIcons');

const TASKS_KEY = 'agentWorkspace.tasks.v1';
const ACTIVE_KEY = 'agentWorkspace.activeTask.v1';
const PRESETS_KEY = 'agentWorkspace.presets.v1';
const APPEARANCE_KEY = 'agentWorkspace.repositoryAppearance.v1';
const EXCLUDE = '**/{.git,node_modules,dist,build,out,coverage}/**';
const MODE_TEXT = { none: 'Excluded', read: 'Read only', write: 'Writable' };

function folders() { return vscode.workspace.workspaceFolders || []; }
function rootKey(folder) { return folder.uri.toString(); }
function simpleItem(label, description, icon, collapsible = false) {
  const item = new vscode.TreeItem(label, collapsible ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
  item.description = description;
  if (icon) item.iconPath = new vscode.ThemeIcon(icon);
  return item;
}
function shortName(folder) { return folder.name || path.basename(folder.uri.fsPath); }
function relativeLabel(root, uri) { return path.relative(root.fsPath, uri.fsPath) || '.'; }
function taskContent(task) { return task?.content ?? task?.goal ?? ''; }
function contentSummary(task) { return taskContent(task).split(/\r?\n/)[0].slice(0, 100); }
function renderContext(data) {
  const lines = [`# ${data.title}`, '', '## Task content', '', data.content, '', '## Repositories and scope'];
  for (const root of data.roots) {
    lines.push(`- ${root.name} — ${MODE_TEXT[root.scope.mode]} — ${root.path} — Branch: ${root.branch || 'Unknown'}`);
    if (root.scope.directories?.length) lines.push(...root.scope.directories.map(directory => `  - Directory: ${directory}`));
  }
  lines.push('', 'The developer declares the scope. Actual read and write permissions depend on the agent and runtime.', '', '## Project instructions');
  if (!data.conventions.length) lines.push('No instruction files selected.');
  for (const file of data.conventions) {
    lines.push('', `### ${file.path}`, `Source: ${file.source}`);
    if (file.error) lines.push(file.error);
    else lines.push('```text', file.content.replace(/```/g, '` ` `'), '```', file.truncated ? '(Content truncated at 32 KiB)' : '');
  }
  return lines.join('\n');
}
function conventionInScope(scope, root, uri) {
  if (isWithinScope(scope, root, uri.fsPath)) return true;
  if (scope.mode === 'none' || relativeInside(root, uri.fsPath) === null) return false;
  return scope.directories?.some(directory => relativeInside(path.dirname(uri.fsPath), path.resolve(root, directory)) !== null) || false;
}

class WorkspaceModel {
  constructor(context) {
    this.context = context;
    this.tasks = context.workspaceState.get(TASKS_KEY, []);
    this.activeId = context.workspaceState.get(ACTIVE_KEY);
    this.presets = context.workspaceState.get(PRESETS_KEY, []);
    this.repositoryAppearance = context.workspaceState.get(APPEARANCE_KEY, {});
    this.git = null;
    this.emitter = new vscode.EventEmitter();
    this.onDidChange = this.emitter.event;
    this.gitSubscriptions = [];
    this.refreshTimer = null;
    this.captureBusy = false;
    this.captureAgain = false;
    this.capturePromise = null;
  }
  active() { return this.tasks.find(t => t.id === this.activeId); }
  async save() {
    await Promise.all([
      this.context.workspaceState.update(TASKS_KEY, this.tasks),
      this.context.workspaceState.update(ACTIVE_KEY, this.activeId),
      this.context.workspaceState.update(PRESETS_KEY, this.presets),
      this.context.workspaceState.update(APPEARANCE_KEY, this.repositoryAppearance)
    ]);
    this.refresh();
  }
  refresh() { this.emitter.fire(); }
  scheduleRefresh() {
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      this.refresh();
      this.captureActiveExecutions().catch(error => console.error('Agent Workspace execution capture:', error));
    }, 250);
  }
  async captureActiveExecutions() {
    if (!vscode.workspace.isTrusted || !this.git) return;
    if (this.captureBusy) { this.captureAgain = true; return this.capturePromise; }
    this.captureBusy = true;
    this.capturePromise = (async () => {
      do {
        this.captureAgain = false;
        await this.captureOnce();
      } while (this.captureAgain);
    })().finally(() => { this.captureBusy = false; this.capturePromise = null; });
    return this.capturePromise;
  }
  async captureOnce() {
    const active = this.tasks.flatMap(task => (task.executions || []).filter(execution => execution.status === 'sent' && !execution.endedAt).map(execution => ({ task, execution })));
    if (!active.length) return;
    const roots = folders().filter(folder => this.repoFor(folder));
    if (!roots.length) return;
    const snapshots = await Promise.all(roots.map(async folder => ({ folder, changes: await this.changes(folder), head: this.head(this.repoFor(folder)) })));
    const at = new Date().toISOString();
    let changed = false;
    for (const { execution } of active) {
      const current = [];
      for (const { folder, changes, head } of snapshots) {
        const key = rootKey(folder);
        const baseline = execution.baseline[key];
        const headChanged = !!baseline && (baseline.branch !== head.branch || baseline.commit !== head.commit);
        for (const change of changes) {
          const classification = classifyChange(change, baseline, execution.scopes[key] || { mode: 'none' }, folder.uri.fsPath, headChanged);
          current.push({ root: key, key: change.key, uri: change.uri.toString(), status: change.status, digest: change.digest, kind: classification.kind, warning: classification.warning });
        }
      }
      const next = mergeObserved(execution.observed || {}, current, at, snapshots.map(snapshot => rootKey(snapshot.folder)));
      if (JSON.stringify(next) !== JSON.stringify(execution.observed || {})) {
        execution.observed = next;
        changed = true;
      }
      const heads = Object.fromEntries(snapshots.map(snapshot => [rootKey(snapshot.folder), snapshot.head]));
      if (JSON.stringify(heads) !== JSON.stringify(execution.heads || {})) {
        execution.heads = heads;
        changed = true;
      }
    }
    if (changed) { await this.context.workspaceState.update(TASKS_KEY, this.tasks); this.refresh(); }
  }
  async connectGit() {
    const extension = vscode.extensions.getExtension('vscode.git');
    if (!extension) return;
    try {
      const exports = await extension.activate();
      this.git = exports.getAPI(1);
      this.gitSubscriptions.forEach(d => d.dispose());
      this.gitSubscriptions = [
        this.git.onDidOpenRepository(() => this.watchRepositories()),
        this.git.onDidCloseRepository(() => this.watchRepositories())
      ];
      this.watchRepositories();
    } catch (error) {
      vscode.window.showWarningMessage(`Agent Workspace could not access the built-in Git extension: ${error.message}`);
    }
  }
  watchRepositories() {
    this.gitSubscriptions.splice(2).forEach(d => d.dispose());
    for (const repo of this.git?.repositories || []) {
      this.gitSubscriptions.push(repo.state.onDidChange(() => this.scheduleRefresh()));
    }
    this.scheduleRefresh();
  }
  repoFor(folder) {
    if (!this.git) return undefined;
    return this.git.repositories.find(r => relativeInside(folder.uri.fsPath, r.rootUri.fsPath) === '' || relativeInside(r.rootUri.fsPath, folder.uri.fsPath) === '');
  }
  changeCount(folder) {
    const repo = this.repoFor(folder);
    if (!repo) return 0;
    const uris = new Set();
    for (const change of [
      ...(repo.state.mergeChanges || []),
      ...(repo.state.indexChanges || []),
      ...(repo.state.workingTreeChanges || []),
      ...(repo.state.untrackedChanges || [])
    ]) {
      if (relativeInside(folder.uri.fsPath, change.uri.fsPath) !== null) uris.add(change.uri.toString());
    }
    return uris.size;
  }
  scope(task, folder) { return task?.scopes?.[rootKey(folder)] || { mode: 'none', directories: [] }; }
  appearance(folder) { return this.repositoryAppearance[rootKey(folder)]; }
  async updateExplorerIcons(activateTheme = false) {
    const themeDirectory = path.join(this.context.extensionPath, 'media', 'theme');
    const customDirectory = path.join(themeDirectory, 'images', 'custom');
    await fs.promises.mkdir(customDirectory, { recursive: true });
    const base = JSON.parse(await fs.promises.readFile(path.join(themeDirectory, 'base.json'), 'utf8'));
    const entries = [];
    for (const folder of folders()) {
      const appearance = this.appearance(folder);
      if (!appearance) continue;
      let definition;
      if (appearance.kind === 'icon' && base.iconDefinitions[appearance.value]) {
        definition = appearance.value;
      } else if (appearance.kind === 'emoji' || appearance.kind === 'image') {
        const extension = appearance.kind === 'emoji' ? '.svg' : path.extname(vscode.Uri.parse(appearance.value).fsPath).toLowerCase();
        const filename = customFileName(rootKey(folder), extension);
        const destination = path.join(customDirectory, filename);
        if (appearance.kind === 'emoji') await fs.promises.writeFile(destination, emojiSvg(appearance.value));
        else await fs.promises.copyFile(vscode.Uri.parse(appearance.value).fsPath, destination);
        definition = `aw_${customFileName(rootKey(folder), '')}`;
        base.iconDefinitions[definition] = { iconPath: `./images/custom/${filename}` };
      }
      if (definition) {
        entries.push({ name: shortName(folder), definition });
        const actualName = path.basename(folder.uri.fsPath);
        if (actualName.toLowerCase() !== shortName(folder).toLowerCase()) entries.push({ name: actualName, definition });
      }
    }
    const theme = buildTheme(base, entries);
    const currentPath = path.join(themeDirectory, 'current.json');
    const nextText = JSON.stringify(theme);
    let previousText;
    try { previousText = await fs.promises.readFile(currentPath, 'utf8'); } catch { /* new installation */ }
    const changed = previousText !== nextText;
    if (changed) await fs.promises.writeFile(currentPath, nextText);
    if (activateTheme) {
      const config = vscode.workspace.getConfiguration('workbench');
      const active = config.get('iconTheme') === 'agent-workspace-roots';
      if (!active) await config.update('iconTheme', 'agent-workspace-roots', vscode.ConfigurationTarget.Workspace);
      if (changed || !active) await vscode.commands.executeCommand('workbench.action.reloadWindow');
    }
  }
  async configureRepositoryAppearance(target) {
    const folder = target?.folder || (target?.uri ? target : target?.scheme ? vscode.workspace.getWorkspaceFolder(target) : undefined) || await this.pickFolder();
    if (!folder?.uri) return;
    const selected = await vscode.window.showQuickPick([
      { label: 'Upload image', kind: 'image', description: 'PNG, JPEG, WebP, or GIF; maximum 2 MB' },
      { label: 'Use emoji', kind: 'emoji', description: 'Set for this repository only' },
      { label: 'Use built-in icon', kind: 'icon', description: 'Choose a VS Code icon' },
      { label: 'Restore default', kind: 'default' }
    ], { title: `Set display icon for ${shortName(folder)}` });
    if (!selected) return;
    let appearance;
    if (selected.kind === 'image') {
      const files = await vscode.window.showOpenDialog({ title: `Upload icon image for ${shortName(folder)}`, canSelectFiles: true, canSelectFolders: false, canSelectMany: false, filters: { Image: ['png', 'jpg', 'jpeg', 'webp', 'gif'] } });
      if (!files?.length) return;
      const source = files[0];
      const extension = path.extname(source.fsPath).toLowerCase();
      if (!['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(extension)) return vscode.window.showErrorMessage('Choose a PNG, JPEG, WebP, or GIF image.');
      const stat = await vscode.workspace.fs.stat(source);
      if (stat.size > 2 * 1024 * 1024) return vscode.window.showErrorMessage('Image exceeds 2 MB. Choose a smaller file.');
      const iconsDir = vscode.Uri.joinPath(this.context.globalStorageUri, 'repository-icons');
      await vscode.workspace.fs.createDirectory(iconsDir);
      const destination = vscode.Uri.joinPath(iconsDir, `${crypto.randomUUID()}${extension}`);
      await vscode.workspace.fs.copy(source, destination, { overwrite: false });
      appearance = { kind: 'image', value: destination.toString() };
    } else if (selected.kind === 'emoji') {
      const value = await vscode.window.showInputBox({ title: `Emoji for ${shortName(folder)}`, prompt: 'Enter one emoji, such as 🧪, ☁️, or 💎', value: this.appearance(folder)?.kind === 'emoji' ? this.appearance(folder).value : '', validateInput: input => !input.trim() ? 'Enter an emoji' : [...input.trim()].length > 16 ? 'Enter one short emoji' : undefined });
      if (value === undefined) return;
      appearance = { kind: 'emoji', value: value.trim() };
    } else if (selected.kind === 'icon') {
      const icon = await vscode.window.showQuickPick(ICONS.map(([value, label]) => ({ label, description: value, value })), { title: `Built-in icon for ${shortName(folder)}` });
      if (!icon) return;
      appearance = { kind: 'icon', value: icon.value };
    }
    const previous = this.appearance(folder);
    if (appearance) this.repositoryAppearance[rootKey(folder)] = appearance;
    else delete this.repositoryAppearance[rootKey(folder)];
    await this.save();
    try { await this.updateExplorerIcons(true); }
    catch (error) { vscode.window.showErrorMessage(`Could not update Explorer icon: ${error.message}`); }
    if (previous?.kind === 'image' && previous.value !== appearance?.value) {
      try { await vscode.workspace.fs.delete(vscode.Uri.parse(previous.value)); } catch { /* old image may already be gone */ }
    }
  }
  head(repo) { return { branch: repo?.state.HEAD?.name || '', commit: repo?.state.HEAD?.commit || '' }; }
  async digest(uri, repo) {
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.type !== vscode.FileType.File) return 'not-file';
      const bytes = await vscode.workspace.fs.readFile(uri);
      return crypto.createHash('sha256').update(bytes).digest('hex');
    } catch {
      try {
        const diff = await repo?.diffWithHEAD(uri.fsPath);
        if (diff !== undefined) return crypto.createHash('sha256').update(diff).digest('hex');
      } catch { /* Git may not have a HEAD yet */ }
      return 'missing';
    }
  }
  async changes(folder) {
    const repo = this.repoFor(folder);
    if (!repo) return [];
    const groups = [
      ['merge', repo.state.mergeChanges],
      ['index', repo.state.indexChanges],
      ['working', repo.state.workingTreeChanges],
      ['untracked', repo.state.untrackedChanges]
    ];
    const result = new Map();
    for (const [group, changes] of groups) for (const change of changes || []) {
      const uri = change.uri;
      const rel = relativeInside(folder.uri.fsPath, uri.fsPath);
      if (rel === null) continue;
      const key = rel.replaceAll(path.sep, '/');
      const prior = result.get(key);
      result.set(key, { key, uri, group: prior ? `${prior.group}+${group}` : group, status: prior ? `${prior.status}+${change.status}` : String(change.status) });
    }
    return Promise.all([...result.values()].map(async change => ({ ...change, digest: await this.digest(change.uri, repo) })));
  }
  async baseline() {
    const result = {};
    for (const folder of folders()) {
      const repo = this.repoFor(folder);
      const files = {};
      for (const change of await this.changes(folder)) files[change.key] = { status: change.status, digest: change.digest };
      result[rootKey(folder)] = { ...this.head(repo), files };
    }
    return result;
  }
  createTask(prefill) { this.openTaskForm(null, prefill); }
  editTask() {
    const task = this.active();
    if (!task) return this.noTask();
    this.openTaskForm(task);
  }
  openTaskForm(task, prefill) {
    const panel = vscode.window.createWebviewPanel('agentWorkspace.taskForm', task ? `Edit task: ${task.title}` : 'New Task', vscode.ViewColumn.One, { enableScripts: true, retainContextWhenHidden: true });
    const nonce = crypto.randomBytes(16).toString('base64');
    panel.webview.html = taskFormHtml({
      title: task?.title || prefill?.title || '',
      content: taskContent(task || prefill),
      roots: folders().map((folder, index) => ({ index, name: shortName(folder), key: rootKey(folder), mode: (task?.scopes?.[rootKey(folder)] || prefill?.scopes?.[rootKey(folder)])?.mode || 'none' })),
      nonce,
      cspSource: panel.webview.cspSource,
      editing: !!task
    });
    panel.webview.onDidReceiveMessage(async message => {
      if (message?.type !== 'save') return;
      try {
        const title = String(message.title || '').trim();
        const content = String(message.content || '').trim();
        if (!title || !content) throw new Error('Enter a title and task content.');
        const scopes = {};
        for (const folder of folders()) {
          const key = rootKey(folder);
          const mode = message.scopes?.[key];
          if (!['none', 'read', 'write'].includes(mode)) throw new Error(`Invalid repository scope: ${shortName(folder)}`);
          const previous = task?.scopes?.[key] || prefill?.scopes?.[key];
          scopes[key] = { mode, directories: mode === 'none' ? [] : [...(previous?.directories || [])] };
        }
        if (task) {
          task.title = title;
          task.content = content;
          task.scopes = scopes;
        } else {
          task = { id: crypto.randomUUID(), title, content, createdAt: new Date().toISOString(), scopes, conventions: [], baseline: await this.baseline() };
          this.tasks.push(task);
          this.activeId = task.id;
        }
        await this.save();
        panel.dispose();
        vscode.window.showInformationMessage(`Task “${task.title}” saved.`);
      } catch (error) {
        panel.webview.postMessage({ type: 'error', message: error.message });
      }
    });
  }
  async setScope(folder) {
    const task = this.active();
    if (!task) return this.noTask();
    folder ||= await this.pickFolder();
    if (!folder) return;
    const choice = await vscode.window.showQuickPick([
      { label: 'Writable', mode: 'write' }, { label: 'Read only', mode: 'read' }, { label: 'Excluded', mode: 'none' }
    ], { title: `Task scope for ${shortName(folder)}` });
    if (!choice) return;
    const current = this.scope(task, folder);
    task.scopes[rootKey(folder)] = { mode: choice.mode, directories: choice.mode === 'none' ? [] : current.directories };
    await this.save();
  }
  async addDirectory(folder) {
    const task = this.active();
    if (!task) return this.noTask();
    folder ||= await this.pickFolder();
    if (!folder) return;
    const scope = this.scope(task, folder);
    if (scope.mode === 'none') return vscode.window.showWarningMessage('Set this repository to Read only or Writable first.');
    if (folder.uri.scheme !== 'file') return vscode.window.showWarningMessage('Directory scopes currently require a local file workspace.');
    const selected = await vscode.window.showOpenDialog({ title: `Choose a scope directory in ${shortName(folder)}`, defaultUri: folder.uri, canSelectFolders: true, canSelectFiles: false, canSelectMany: false, openLabel: 'Add to scope' });
    if (!selected?.length) return;
    const rel = relativeInside(folder.uri.fsPath, selected[0].fsPath);
    if (rel === null) return vscode.window.showErrorMessage('The selected directory is outside the workspace root and cannot be added to the task scope.');
    if (!rel) return vscode.window.showWarningMessage('The entire repository is already included; there is no need to add its root.');
    scope.directories = [...new Set([...(scope.directories || []), rel])];
    task.scopes[rootKey(folder)] = scope;
    await this.save();
  }
  async removeDirectory(item) {
    const task = this.active();
    if (!task || item?.kind !== 'directory') return;
    const scope = this.scope(task, item.folder);
    scope.directories = scope.directories.filter(d => d !== item.directory);
    await this.save();
  }
  async collectConventions() {
    const task = this.active();
    if (!task) return this.noTask();
    const picks = [];
    for (const folder of folders()) {
      const scope = this.scope(task, folder);
      if (scope.mode === 'none') continue;
      const uris = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, '**/AGENTS.md'), EXCLUDE, 200);
      for (const uri of uris) {
        if (!conventionInScope(scope, folder.uri.fsPath, uri)) continue;
        const key = uri.toString();
        picks.push({ label: `${shortName(folder)}/${relativeLabel(folder.uri, uri)}`, description: 'Workspace file', uri, key, picked: task.conventions.includes(key) });
      }
    }
    if (!picks.length) return vscode.window.showInformationMessage('No AGENTS.md file was found within the current task scope.');
    const selected = await vscode.window.showQuickPick(picks, { title: 'Select project instructions for the context package', canPickMany: true });
    if (!selected) return;
    task.conventions = selected.map(p => p.key);
    await this.save();
  }
  async contextData() {
    const task = this.active();
    if (!task) return null;
    const roots = folders().map(folder => {
      const repo = this.repoFor(folder);
      return { name: shortName(folder), uri: folder.uri.toString(), path: folder.uri.fsPath, branch: repo?.state.HEAD?.name || null, scope: this.scope(task, folder) };
    });
    const conventions = [];
    for (const key of task.conventions) {
      const uri = vscode.Uri.parse(key);
      const folder = vscode.workspace.getWorkspaceFolder(uri);
      if (!folder || !conventionInScope(this.scope(task, folder), folder.uri.fsPath, uri)) continue;
      try {
        const bytes = await vscode.workspace.fs.readFile(uri);
        const max = 32768;
        conventions.push({ path: uri.fsPath, source: 'Workspace file', content: Buffer.from(bytes.subarray(0, max)).toString('utf8'), truncated: bytes.length > max });
      } catch { conventions.push({ path: uri.fsPath, source: 'Workspace file', error: 'Could not read file or file was deleted' }); }
    }
    return { title: task.title, content: taskContent(task), createdAt: task.createdAt, roots, conventions };
  }
  async copyContext() {
    const data = await this.contextData();
    if (!data) return this.noTask();
    await vscode.env.clipboard.writeText(renderContext(data));
    vscode.window.showInformationMessage('Task context copied to the clipboard.');
  }
  async executeTask() {
    const data = await this.contextData();
    if (!data) return this.noTask();
    if (!vscode.workspace.isTrusted) return vscode.window.showWarningMessage('This workspace is in Restricted Mode. Trust it in VS Code before running Copilot Agent.');
    const task = this.active();
    const baseline = await this.baseline();
    const startedAt = new Date().toISOString();
    try { await vscode.commands.executeCommand('workbench.action.chat.open', copilotAgentOptions(renderContext(data))); }
    catch (error) { return vscode.window.showErrorMessage(`Could not run the task with Copilot Agent: ${error.message}. Make sure GitHub Copilot is enabled and signed in.`); }
    try {
      await this.captureActiveExecutions();
      for (const candidate of this.tasks) for (const execution of candidate.executions || []) {
        if (execution.status === 'sent' && !execution.endedAt) execution.endedAt = startedAt;
      }
      const execution = {
        id: crypto.randomUUID(), startedAt, status: 'sent', title: data.title, content: data.content,
        scopes: JSON.parse(JSON.stringify(task.scopes)), conventions: data.conventions.map(file => file.path), baseline, observed: {}
      };
      task.executions ||= [];
      task.executions.unshift(execution);
      await this.save();
      await this.captureActiveExecutions();
    } catch (error) {
      vscode.window.showErrorMessage(`Task sent to Copilot, but the execution record could not be saved: ${error.message}`);
    }
  }
  async stopExecutionTracking(execution) {
    if (!execution || execution.endedAt) return;
    await this.captureActiveExecutions();
    execution.endedAt = new Date().toISOString();
    await this.save();
    vscode.window.showInformationMessage('Stopped tracking changes for this execution. Copilot will continue running.');
  }
  async openCopilotSessions(execution) {
    await vscode.commands.executeCommand('workbench.action.chat.open');
    const time = execution ? new Date(execution.startedAt).toLocaleString() : '';
    vscode.window.showInformationMessage(`Find “${execution?.title || 'Task'}” around ${time} in the Copilot session list. If the list is hidden, right-click empty space in Chat and select Show Sessions.`);
  }
  async showExecutionDetails(execution) {
    if (!execution) return;
    const lines = [`# ${execution.title}`, '', `Sent at: ${new Date(execution.startedAt).toLocaleString()}`, `Status: ${execution.endedAt ? 'Change tracking stopped' : 'Tracking changes (Copilot may no longer be running)'}`, '', '## Task content', '', execution.content, '', '## Repository scope'];
    for (const folder of folders()) {
      const scope = execution.scopes[rootKey(folder)] || { mode: 'none', directories: [] };
      lines.push(`- ${shortName(folder)}: ${MODE_TEXT[scope.mode]}`);
      for (const directory of scope.directories || []) lines.push(`  - ${directory}`);
    }
    lines.push('', '## Instruction files', ...(execution.conventions.length ? execution.conventions.map(file => `- ${file}`) : ['None selected']), '', `Changes observed in ${observedCount(execution)} files. Some changes may have come from sources other than Copilot.`);
    const document = await vscode.workspace.openTextDocument({ language: 'markdown', content: lines.join('\n') });
    await vscode.window.showTextDocument(document, { preview: true });
  }
  async openObservedChange(observation) {
    if (!observation) return;
    const uri = vscode.Uri.parse(observation.uri);
    if (observation.present) {
      try { await vscode.commands.executeCommand('git.openChange', uri); return; } catch { /* use file fallback */ }
    }
    try { await vscode.commands.executeCommand('vscode.open', uri); }
    catch { vscode.window.showWarningMessage('This file no longer exists. The record retains only its path and status.'); }
  }
  async exportJson() {
    const data = await this.contextData();
    if (!data) return this.noTask();
    const uri = await vscode.window.showSaveDialog({ title: 'Export Task JSON', defaultUri: vscode.Uri.file(path.join(folders()[0]?.uri.fsPath || process.cwd(), 'agent-workspace-task.json')), filters: { JSON: ['json'] } });
    if (!uri) return;
    await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(data, null, 2), 'utf8'));
    vscode.window.showInformationMessage(`Task exported: ${uri.fsPath}`);
  }
  async savePreset() {
    const task = this.active();
    if (!task) return this.noTask();
    const name = await vscode.window.showInputBox({ title: 'Save Task Preset', prompt: 'Preset name', value: task.title });
    if (!name?.trim()) return;
    this.presets.push({ id: crypto.randomUUID(), name: name.trim(), content: taskContent(task), scopes: JSON.parse(JSON.stringify(task.scopes)) });
    await this.save();
  }
  async applyPreset(preset) {
    preset ||= await vscode.window.showQuickPick(this.presets.map(p => ({ label: p.name, preset: p })), { title: 'Select Task Preset' }).then(x => x?.preset);
    if (preset) this.createTask({ title: preset.name, content: taskContent(preset), scopes: preset.scopes });
  }
  async applyPresetRoots(preset) {
    if (!preset) return;
    const desired = [];
    for (const [key, scope] of Object.entries(preset.scopes)) {
      if (scope.mode === 'none') continue;
      const uri = vscode.Uri.parse(key);
      try {
        const stat = await vscode.workspace.fs.stat(uri);
        if (stat.type !== vscode.FileType.Directory) throw new Error('Not a directory');
      } catch {
        return vscode.window.showErrorMessage(`Preset root does not exist or cannot be accessed: ${uri.fsPath}`);
      }
      desired.push({ uri });
    }
    if (!desired.length) return vscode.window.showWarningMessage('This preset does not include any repositories.');
    const names = desired.map(entry => path.basename(entry.uri.fsPath)).join(', ');
    const answer = await vscode.window.showWarningMessage(`Change the current workspace roots to: ${names}?`, { modal: true }, 'Apply to Workspace');
    if (answer !== 'Apply to Workspace') return;
    if (!vscode.workspace.updateWorkspaceFolders(0, folders().length, ...desired)) {
      vscode.window.showErrorMessage('Could not update the workspace roots.');
    }
  }
  async deletePreset(preset) {
    if (!preset) return;
    const yes = await vscode.window.showWarningMessage(`Delete preset “${preset.name}”?`, { modal: true }, 'Delete');
    if (yes !== 'Delete') return;
    this.presets = this.presets.filter(p => p.id !== preset.id);
    await this.save();
  }
  async selectTask() {
    const pick = await vscode.window.showQuickPick(this.tasks.map(t => ({ label: t.title, description: contentSummary(t), id: t.id })), { title: 'Select Task' });
    if (pick) { this.activeId = pick.id; await this.save(); }
  }
  async deleteTask() {
    const task = this.active();
    if (!task) return this.noTask();
    const yes = await vscode.window.showWarningMessage(`Delete task “${task.title}”?`, { modal: true }, 'Delete');
    if (yes !== 'Delete') return;
    this.tasks = this.tasks.filter(t => t.id !== task.id);
    this.activeId = this.tasks.at(-1)?.id;
    await this.save();
  }
  async rebaseline() {
    const task = this.active();
    if (!task) return this.noTask();
    task.baseline = await this.baseline();
    await this.save();
    vscode.window.showInformationMessage('Task Git baseline rebuilt.');
  }
  async pickFolder() {
    const pick = await vscode.window.showQuickPick(folders().map(folder => ({ label: shortName(folder), folder })), { title: 'Select Repository' });
    return pick?.folder;
  }
  noTask() { vscode.window.showInformationMessage('Create a task first.'); }
  dispose() { clearTimeout(this.refreshTimer); this.gitSubscriptions.forEach(d => d.dispose()); this.emitter.dispose(); }
}

class RepositoriesProvider {
  constructor(model) { this.model = model; this.onDidChangeTreeData = model.onDidChange; }
  getTreeItem(node) { return node.item; }
  async getChildren(node) {
    if (node) return [];
    if (!folders().length) return [{ item: simpleItem('Open a workspace first', '', 'folder') }];
    const roots = await Promise.all(folders().map(async folder => {
      const repo = this.model.repoFor(folder);
      const count = this.model.changeCount(folder);
      const head = repo?.state.HEAD;
      const branch = head?.name || (vscode.workspace.isTrusted ? 'No Git repository found' : 'Git unavailable');
      const sync = [head?.ahead ? `↑${head.ahead}` : '', head?.behind ? `↓${head.behind}` : ''].filter(Boolean).join(' ');
      const active = this.model.active();
      const scope = active ? ` · ${MODE_TEXT[this.model.scope(active, folder).mode]}` : '';
      const status = repo ? (count ? `${count} changes` : 'Clean') : 'Status unavailable';
      const item = simpleItem(shortName(folder), `${branch} · ${status}${sync ? ` · ${sync}` : ''}${scope}`, repo ? 'repo' : 'warning');
      const appearance = this.model.appearance(folder);
      if (appearance?.kind === 'image') item.iconPath = vscode.Uri.parse(appearance.value);
      else if (appearance?.kind === 'emoji') item.label = `${appearance.value} ${shortName(folder)}`;
      else if (appearance?.kind === 'icon') item.iconPath = new vscode.ThemeIcon(appearance.value.slice(1));
      item.contextValue = 'awRepository';
      item.tooltip = `${folder.uri.fsPath}\nBranch: ${branch}\nTask scope: ${scope || 'No task'}`;
      item.command = { command: 'agentWorkspace.openFolder', title: 'Open Folder', arguments: [folder] };
      return { item, folder };
    }));
    if (!vscode.workspace.isTrusted) {
      const item = simpleItem('Restricted Mode: Git status unavailable', 'Trust the workspace to see branches and changes', 'lock');
      item.tooltip = 'VS Code does not provide Git source control in Restricted Mode. You can choose whether to trust this workspace in VS Code.';
      return [{ item }, ...roots];
    }
    return roots;
  }
}

class TasksProvider {
  constructor(model) { this.model = model; this.onDidChangeTreeData = model.onDidChange; }
  getTreeItem(node) { return node.item; }
  async getChildren(node) {
    const task = this.model.active();
    if (!task) return [
      { item: Object.assign(simpleItem('New Task', 'Enter a title, content, and repository scope', 'add'), { command: { command: 'agentWorkspace.createTask', title: 'New Task' } }) },
      { item: Object.assign(simpleItem('Guide', 'View the full instructions', 'book'), { command: { command: 'agentWorkspace.openGuide', title: 'Open Guide' } }) }
    ];
    if (!node) {
      const active = simpleItem(task.title, contentSummary(task), 'target');
      active.command = { command: 'agentWorkspace.editTask', title: 'Edit Task' };
      return [
        { kind: 'header', item: active },
        { kind: 'execute', item: Object.assign(simpleItem('Execute', 'Run with Copilot Agent', 'play'), { command: { command: 'agentWorkspace.executeTask', title: 'Execute Task' } }) },
        { kind: 'executions', item: simpleItem('Execution Records', `${(task.executions || []).length} runs`, 'history', true) },
        { kind: 'scopes', item: simpleItem('Repository scope', '', 'folder-library', true) },
        { kind: 'conventions', item: simpleItem('Project instructions', `${task.conventions.length} files`, 'book', true) },
        { kind: 'changes', item: simpleItem('Git Change Review', '', 'git-compare', true) },
        { kind: 'actions', item: simpleItem('Actions', '', 'tools', true) }
      ];
    }
    if (node.kind === 'executions') {
      if (!task.executions?.length) return [{ item: simpleItem('No execution records', 'Click Execute to start recording', 'info') }];
      return task.executions.map(execution => {
        const when = new Date(execution.startedAt).toLocaleString();
        const item = simpleItem(when, `${execution.endedAt ? 'Tracking ended' : 'Tracking'} · ${observedCount(execution)} files`, 'history', true);
        item.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
        item.tooltip = `${execution.title}\n${when}\nFile changes were observed after execution; they may not all be from Copilot.`;
        return { kind: 'execution', item, execution };
      });
    }
    if (node.kind === 'execution') {
      const execution = node.execution;
      const entries = [
        { item: Object.assign(simpleItem('View Task Snapshot', contentSummary(execution), 'file-text'), { command: { command: 'agentWorkspace.showExecutionDetails', title: 'View Execution Record', arguments: [execution] } }) },
        { item: Object.assign(simpleItem('Open Copilot Sessions', 'Find by title and time', 'comment-discussion'), { command: { command: 'agentWorkspace.openCopilotSessions', title: 'Open Copilot Sessions', arguments: [execution] } }) }
      ];
      if (!execution.endedAt) entries.push({ item: Object.assign(simpleItem('Stop Tracking Changes', 'Copilot will continue running', 'stop-circle'), { command: { command: 'agentWorkspace.stopExecutionTracking', title: 'Stop Tracking Changes', arguments: [execution] } }) });
      const observations = Object.values(execution.observed || {});
      for (const folder of folders()) {
        const rootObservations = observations.filter(observation => observation.root === rootKey(folder));
        const baseline = execution.baseline?.[rootKey(folder)];
        const head = execution.heads?.[rootKey(folder)];
        const headChanged = !!baseline && !!head && (baseline.branch !== head.branch || baseline.commit !== head.commit);
        if (!rootObservations.length && !headChanged) continue;
        const item = simpleItem(shortName(folder), `${rootObservations.length} files${headChanged ? ' · HEAD changed' : ''}`, headChanged ? 'warning' : 'repo', true);
        entries.push({ kind: 'executionRoot', item, folder, observations: rootObservations });
      }
      if (!observations.length) entries.push({ item: simpleItem('No file changes observed yet', 'Updates when Git status changes', 'info') });
      return entries;
    }
    if (node.kind === 'executionRoot') return node.observations.map(observation => {
      const kind = { new: 'New after execution', uncertain: 'Origin uncertain', invalid: 'Baseline invalid' }[observation.kind] || 'Observed after execution';
      const item = simpleItem(observation.key, `${kind}${observation.present ? '' : ' · No current Git changes'}${observation.warning ? ' · Scope warning' : ''}`, observation.warning ? 'warning' : 'diff');
      item.tooltip = `${observation.warning || 'Change observed after execution; its origin cannot be attributed to Copilot.'}\nLast seen: ${new Date(observation.lastSeenAt).toLocaleString()}`;
      item.command = { command: 'agentWorkspace.openObservedChange', title: 'Open Recorded File', arguments: [observation] };
      return { item };
    });
    if (node.kind === 'scopes') return folders().map(folder => {
      const scope = this.model.scope(task, folder);
      const item = simpleItem(shortName(folder), `${MODE_TEXT[scope.mode]}${scope.directories?.length ? ` · ${scope.directories.length} directories` : ''}`, scope.mode === 'write' ? 'edit' : scope.mode === 'read' ? 'eye' : 'circle-slash', !!scope.directories?.length);
      item.command = { command: 'agentWorkspace.setScope', title: 'Set Scope', arguments: [folder] };
      return { kind: 'scope', item, folder };
    });
    if (node.kind === 'scope') return node.folder && this.model.scope(task, node.folder).directories.map(directory => {
      const item = simpleItem(directory, '', 'folder');
      item.contextValue = 'awDirectory';
      return { kind: 'directory', item, folder: node.folder, directory };
    });
    if (node.kind === 'conventions') {
      const entries = task.conventions.map(key => {
        const uri = vscode.Uri.parse(key);
        const item = simpleItem(vscode.workspace.asRelativePath(uri), '', 'file');
        item.command = { command: 'vscode.open', title: 'Open Instructions', arguments: [uri] };
        return { item };
      });
      entries.push({ item: Object.assign(simpleItem('Select AGENTS.md', '', 'add'), { command: { command: 'agentWorkspace.collectConventions', title: 'Select Project Instructions' } }) });
      return entries;
    }
    if (node.kind === 'changes') return Promise.all(folders().map(async folder => {
      const repo = this.model.repoFor(folder);
      const changes = await this.model.changes(folder);
      const baseline = task.baseline?.[rootKey(folder)];
      const current = this.model.head(repo);
      const invalid = baseline && (baseline.commit !== current.commit || baseline.branch !== current.branch);
      const item = simpleItem(shortName(folder), repo ? `${changes.length} changes${invalid ? ' · Baseline invalid' : ''}` : 'Git status unavailable', invalid || !repo ? 'warning' : 'repo', true);
      return { kind: 'changeRoot', item, folder, changes, baseline, invalid, unavailable: !repo };
    }));
    if (node.kind === 'changeRoot') {
      if (node.unavailable) return [{ item: simpleItem('Git status unavailable', 'Check workspace trust and the built-in Git extension', 'lock') }];
      if (!node.changes.length) return [{ item: simpleItem('No changes', '', 'check') }];
      return node.changes.map(change => {
        const result = classifyChange(change, node.baseline, this.model.scope(task, node.folder), node.folder.uri.fsPath, node.invalid);
        const kind = { new: 'New change', existing: 'Existing before task', uncertain: 'Origin uncertain', invalid: 'Baseline invalid' }[result.kind];
        const item = simpleItem(change.key, `${kind}${result.warning ? ' · Outside scope or baseline needs rebuilding' : ''}`, result.warning ? 'warning' : 'diff');
        item.tooltip = `${kind}\n${result.warning || ''}\nGit group: ${change.group}`;
        item.contextValue = 'awChange';
        item.command = { command: 'agentWorkspace.openChange', title: 'Open Diff', arguments: [change] };
        return { kind: 'change', item, change };
      });
    }
    if (node.kind === 'actions') return [
      ['Edit Task', 'agentWorkspace.editTask', 'edit'],
      ['Add Scope Directory', 'agentWorkspace.addDirectory', 'folder-opened'],
      ['Copy Context', 'agentWorkspace.copyContext', 'copy'],
      ['Export Task JSON', 'agentWorkspace.exportJson', 'export'],
      ['Switch Task', 'agentWorkspace.selectTask', 'list-selection'],
      ['Rebuild Git Baseline', 'agentWorkspace.rebaseline', 'history'],
      ['Delete Current Task', 'agentWorkspace.deleteTask', 'trash']
    ].map(([label, command, icon]) => ({ item: Object.assign(simpleItem(label, '', icon), { command: { command, title: label } }) }));
    return [];
  }
}

class PresetsProvider {
  constructor(model) { this.model = model; this.onDidChangeTreeData = model.onDidChange; }
  getTreeItem(node) { return node.item; }
  getChildren(node) {
    if (node) return [];
    if (!this.model.presets.length) return [{ item: simpleItem('No presets', 'Save from the current task', 'bookmark') }];
    return this.model.presets.map(preset => {
      const item = simpleItem(preset.name, contentSummary(preset), 'bookmark');
      item.contextValue = 'awPreset';
      item.command = { command: 'agentWorkspace.applyPreset', title: 'Use Preset', arguments: [preset] };
      return { item, preset };
    });
  }
}

async function activate(context) {
  const model = new WorkspaceModel(context);
  context.subscriptions.push(model);
  const register = (name, fn) => context.subscriptions.push(vscode.commands.registerCommand(`agentWorkspace.${name}`, fn));
  register('refresh', () => model.refresh());
  register('configureExplorerIcon', target => model.configureRepositoryAppearance(target));
  register('openGuide', () => vscode.commands.executeCommand('vscode.open', vscode.Uri.joinPath(context.extensionUri, 'README.md')));
  register('createTask', () => model.createTask());
  register('editTask', () => model.editTask());
  register('executeTask', () => model.executeTask());
  register('openCopilotSessions', execution => model.openCopilotSessions(execution));
  register('showExecutionDetails', execution => model.showExecutionDetails(execution));
  register('stopExecutionTracking', execution => model.stopExecutionTracking(execution));
  register('openObservedChange', observation => model.openObservedChange(observation));
  register('selectTask', () => model.selectTask());
  register('deleteTask', () => model.deleteTask());
  register('setScope', folder => model.setScope(folder));
  register('addDirectory', folder => model.addDirectory(folder));
  register('removeDirectory', node => model.removeDirectory(node));
  register('collectConventions', () => model.collectConventions());
  register('copyContext', () => model.copyContext());
  register('exportJson', () => model.exportJson());
  register('savePreset', () => model.savePreset());
  register('applyPreset', node => model.applyPreset(node?.preset || node));
  register('applyPresetRoots', node => model.applyPresetRoots(node?.preset || node));
  register('deletePreset', node => model.deletePreset(node?.preset || node));
  register('rebaseline', () => model.rebaseline());
  register('openFolder', target => {
    const folder = target?.folder || target;
    if (folder?.uri) return vscode.commands.executeCommand('revealInExplorer', folder.uri);
  });
  register('openTerminal', target => {
    const folder = target?.folder || target;
    if (folder?.uri) { const terminal = vscode.window.createTerminal({ name: shortName(folder), cwd: folder.uri.fsPath }); terminal.show(); }
  });
  register('openScm', () => vscode.commands.executeCommand('workbench.view.scm'));
  register('openChange', async target => {
    const change = target?.change || target;
    if (!change?.uri) return;
    try { await vscode.commands.executeCommand('git.openChange', change.uri); }
    catch { await vscode.commands.executeCommand('vscode.open', change.uri); }
  });
  context.subscriptions.push(vscode.window.registerTreeDataProvider('agentWorkspace.repositories', new RepositoriesProvider(model)));
  context.subscriptions.push(vscode.window.registerTreeDataProvider('agentWorkspace.tasks', new TasksProvider(model)));
  context.subscriptions.push(vscode.window.registerTreeDataProvider('agentWorkspace.presets', new PresetsProvider(model)));
  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => model.scheduleRefresh()));
  context.subscriptions.push(vscode.workspace.onDidGrantWorkspaceTrust(() => model.connectGit()));
  try {
    if (context.extensionPath) await model.updateExplorerIcons(vscode.workspace.getConfiguration('workbench').get('iconTheme') === 'agent-workspace-roots');
  }
  catch (error) { console.error('Agent Workspace Explorer icons:', error); }
  await model.connectGit();
}

function deactivate() {}
module.exports = { activate, deactivate };
