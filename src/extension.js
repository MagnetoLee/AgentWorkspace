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
const MODE_TEXT = { none: '未纳入', read: '只读', write: '可改' };

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
  const lines = [`# ${data.title}`, '', '## 任务内容', '', data.content, '', '## 仓库与范围'];
  for (const root of data.roots) {
    lines.push(`- ${root.name} — ${MODE_TEXT[root.scope.mode]} — ${root.path} — 分支：${root.branch || '未知'}`);
    if (root.scope.directories?.length) lines.push(...root.scope.directories.map(directory => `  - 目录：${directory}`));
  }
  lines.push('', '范围由开发者声明；实际读写权限由智能体及运行环境决定。', '', '## 项目约定');
  if (!data.conventions.length) lines.push('未选择约定文件。');
  for (const file of data.conventions) {
    lines.push('', `### ${file.path}`, `来源：${file.source}`);
    if (file.error) lines.push(file.error);
    else lines.push('```text', file.content.replace(/```/g, '` ` `'), '```', file.truncated ? '（内容超过 32 KiB，已截断）' : '');
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
      vscode.window.showWarningMessage(`Agent Workspace 无法读取内置 Git 扩展：${error.message}`);
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
      { label: '上传图片', kind: 'image', description: 'PNG、JPEG、WebP 或 GIF，最大 2 MB' },
      { label: '使用 emoji', kind: 'emoji', description: '为这个仓库单独设置' },
      { label: '使用内置图标', kind: 'icon', description: '选择 VS Code 图标' },
      { label: '恢复默认', kind: 'default' }
    ], { title: `设置 ${shortName(folder)} 的显示图标` });
    if (!selected) return;
    let appearance;
    if (selected.kind === 'image') {
      const files = await vscode.window.showOpenDialog({ title: `上传 ${shortName(folder)} 的图标图片`, canSelectFiles: true, canSelectFolders: false, canSelectMany: false, filters: { 图片: ['png', 'jpg', 'jpeg', 'webp', 'gif'] } });
      if (!files?.length) return;
      const source = files[0];
      const extension = path.extname(source.fsPath).toLowerCase();
      if (!['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(extension)) return vscode.window.showErrorMessage('请选择 PNG、JPEG、WebP 或 GIF 图片。');
      const stat = await vscode.workspace.fs.stat(source);
      if (stat.size > 2 * 1024 * 1024) return vscode.window.showErrorMessage('图片超过 2 MB，请选择更小的文件。');
      const iconsDir = vscode.Uri.joinPath(this.context.globalStorageUri, 'repository-icons');
      await vscode.workspace.fs.createDirectory(iconsDir);
      const destination = vscode.Uri.joinPath(iconsDir, `${crypto.randomUUID()}${extension}`);
      await vscode.workspace.fs.copy(source, destination, { overwrite: false });
      appearance = { kind: 'image', value: destination.toString() };
    } else if (selected.kind === 'emoji') {
      const value = await vscode.window.showInputBox({ title: `${shortName(folder)} 的 emoji`, prompt: '输入一个 emoji，例如 🧪、☁️、💎', value: this.appearance(folder)?.kind === 'emoji' ? this.appearance(folder).value : '', validateInput: input => !input.trim() ? '请输入 emoji' : [...input.trim()].length > 16 ? '请只输入一个简短的 emoji' : undefined });
      if (value === undefined) return;
      appearance = { kind: 'emoji', value: value.trim() };
    } else if (selected.kind === 'icon') {
      const icon = await vscode.window.showQuickPick(ICONS.map(([value, label]) => ({ label, description: value, value })), { title: `${shortName(folder)} 的内置图标` });
      if (!icon) return;
      appearance = { kind: 'icon', value: icon.value };
    }
    const previous = this.appearance(folder);
    if (appearance) this.repositoryAppearance[rootKey(folder)] = appearance;
    else delete this.repositoryAppearance[rootKey(folder)];
    await this.save();
    try { await this.updateExplorerIcons(true); }
    catch (error) { vscode.window.showErrorMessage(`更新 Explorer 图标失败：${error.message}`); }
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
    const panel = vscode.window.createWebviewPanel('agentWorkspace.taskForm', task ? `编辑任务：${task.title}` : '新建任务', vscode.ViewColumn.One, { enableScripts: true, retainContextWhenHidden: true });
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
        if (!title || !content) throw new Error('请填写标题和任务内容。');
        const scopes = {};
        for (const folder of folders()) {
          const key = rootKey(folder);
          const mode = message.scopes?.[key];
          if (!['none', 'read', 'write'].includes(mode)) throw new Error(`仓库范围无效：${shortName(folder)}`);
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
        vscode.window.showInformationMessage(`任务“${task.title}”已保存。`);
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
      { label: '可改', mode: 'write' }, { label: '只读', mode: 'read' }, { label: '未纳入', mode: 'none' }
    ], { title: `${shortName(folder)} 的任务范围` });
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
    if (scope.mode === 'none') return vscode.window.showWarningMessage('请先将该仓库设为只读或可改。');
    if (folder.uri.scheme !== 'file') return vscode.window.showWarningMessage('目录范围目前需要本地文件工作区。');
    const selected = await vscode.window.showOpenDialog({ title: `选择 ${shortName(folder)} 中的范围目录`, defaultUri: folder.uri, canSelectFolders: true, canSelectFiles: false, canSelectMany: false, openLabel: '加入范围' });
    if (!selected?.length) return;
    const rel = relativeInside(folder.uri.fsPath, selected[0].fsPath);
    if (rel === null) return vscode.window.showErrorMessage('所选目录位于工作区根目录之外，无法加入任务范围。');
    if (!rel) return vscode.window.showWarningMessage('已覆盖整仓库，无需添加根目录。');
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
        picks.push({ label: `${shortName(folder)}/${relativeLabel(folder.uri, uri)}`, description: '工作区文件', uri, key, picked: task.conventions.includes(key) });
      }
    }
    if (!picks.length) return vscode.window.showInformationMessage('当前任务范围内未找到 AGENTS.md。');
    const selected = await vscode.window.showQuickPick(picks, { title: '选择要纳入上下文包的项目约定', canPickMany: true });
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
        conventions.push({ path: uri.fsPath, source: '工作区文件', content: Buffer.from(bytes.subarray(0, max)).toString('utf8'), truncated: bytes.length > max });
      } catch { conventions.push({ path: uri.fsPath, source: '工作区文件', error: '读取失败或文件已删除' }); }
    }
    return { title: task.title, content: taskContent(task), createdAt: task.createdAt, roots, conventions };
  }
  async copyContext() {
    const data = await this.contextData();
    if (!data) return this.noTask();
    await vscode.env.clipboard.writeText(renderContext(data));
    vscode.window.showInformationMessage('任务上下文包已复制到剪贴板。');
  }
  async executeTask() {
    const data = await this.contextData();
    if (!data) return this.noTask();
    if (!vscode.workspace.isTrusted) return vscode.window.showWarningMessage('当前工作区处于受限模式，Copilot Agent 无法执行任务。请先在 VS Code 中信任工作区。');
    const task = this.active();
    const baseline = await this.baseline();
    const startedAt = new Date().toISOString();
    try { await vscode.commands.executeCommand('workbench.action.chat.open', copilotAgentOptions(renderContext(data))); }
    catch (error) { return vscode.window.showErrorMessage(`无法交给 Copilot Agent 执行：${error.message}。请确认已启用并登录 GitHub Copilot。`); }
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
      vscode.window.showErrorMessage(`任务已发送给 Copilot，但执行记录保存失败：${error.message}`);
    }
  }
  async stopExecutionTracking(execution) {
    if (!execution || execution.endedAt) return;
    await this.captureActiveExecutions();
    execution.endedAt = new Date().toISOString();
    await this.save();
    vscode.window.showInformationMessage('已停止记录这次执行后的改动；这不会停止 Copilot。');
  }
  async openCopilotSessions(execution) {
    await vscode.commands.executeCommand('workbench.action.chat.open');
    const time = execution ? new Date(execution.startedAt).toLocaleString() : '';
    vscode.window.showInformationMessage(`请在 Copilot 会话列表中按“${execution?.title || '任务'}”和 ${time} 查找。若列表未显示，在聊天空白处右键选择 Show Sessions。`);
  }
  async showExecutionDetails(execution) {
    if (!execution) return;
    const lines = [`# ${execution.title}`, '', `发送时间：${new Date(execution.startedAt).toLocaleString()}`, `状态：${execution.endedAt ? '已停止记录改动' : '正在观察改动（不代表 Copilot 仍在运行）'}`, '', '## 任务内容', '', execution.content, '', '## 仓库范围'];
    for (const folder of folders()) {
      const scope = execution.scopes[rootKey(folder)] || { mode: 'none', directories: [] };
      lines.push(`- ${shortName(folder)}：${MODE_TEXT[scope.mode]}`);
      for (const directory of scope.directories || []) lines.push(`  - ${directory}`);
    }
    lines.push('', '## 约定文件', ...(execution.conventions.length ? execution.conventions.map(file => `- ${file}`) : ['未选择']), '', `观察到 ${observedCount(execution)} 个文件有改动。文件改动不保证全部由 Copilot 产生。`);
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
    catch { vscode.window.showWarningMessage('该文件当前不存在，历史记录只保留了路径和状态。'); }
  }
  async exportJson() {
    const data = await this.contextData();
    if (!data) return this.noTask();
    const uri = await vscode.window.showSaveDialog({ title: '导出任务 JSON', defaultUri: vscode.Uri.file(path.join(folders()[0]?.uri.fsPath || process.cwd(), 'agent-workspace-task.json')), filters: { JSON: ['json'] } });
    if (!uri) return;
    await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(data, null, 2), 'utf8'));
    vscode.window.showInformationMessage(`已导出任务：${uri.fsPath}`);
  }
  async savePreset() {
    const task = this.active();
    if (!task) return this.noTask();
    const name = await vscode.window.showInputBox({ title: '保存任务预设', prompt: '预设名称', value: task.title });
    if (!name?.trim()) return;
    this.presets.push({ id: crypto.randomUUID(), name: name.trim(), content: taskContent(task), scopes: JSON.parse(JSON.stringify(task.scopes)) });
    await this.save();
  }
  async applyPreset(preset) {
    preset ||= await vscode.window.showQuickPick(this.presets.map(p => ({ label: p.name, preset: p })), { title: '选择任务预设' }).then(x => x?.preset);
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
        if (stat.type !== vscode.FileType.Directory) throw new Error('不是目录');
      } catch {
        return vscode.window.showErrorMessage(`预设根目录不存在或无法访问：${uri.fsPath}`);
      }
      desired.push({ uri });
    }
    if (!desired.length) return vscode.window.showWarningMessage('这个预设未纳入任何仓库。');
    const names = desired.map(entry => path.basename(entry.uri.fsPath)).join('、');
    const answer = await vscode.window.showWarningMessage(`将当前工作区根目录调整为：${names}？`, { modal: true }, '应用到工作区');
    if (answer !== '应用到工作区') return;
    if (!vscode.workspace.updateWorkspaceFolders(0, folders().length, ...desired)) {
      vscode.window.showErrorMessage('无法更新当前工作区根目录。');
    }
  }
  async deletePreset(preset) {
    if (!preset) return;
    const yes = await vscode.window.showWarningMessage(`删除预设“${preset.name}”？`, { modal: true }, '删除');
    if (yes !== '删除') return;
    this.presets = this.presets.filter(p => p.id !== preset.id);
    await this.save();
  }
  async selectTask() {
    const pick = await vscode.window.showQuickPick(this.tasks.map(t => ({ label: t.title, description: contentSummary(t), id: t.id })), { title: '选择任务' });
    if (pick) { this.activeId = pick.id; await this.save(); }
  }
  async deleteTask() {
    const task = this.active();
    if (!task) return this.noTask();
    const yes = await vscode.window.showWarningMessage(`删除任务“${task.title}”？`, { modal: true }, '删除');
    if (yes !== '删除') return;
    this.tasks = this.tasks.filter(t => t.id !== task.id);
    this.activeId = this.tasks.at(-1)?.id;
    await this.save();
  }
  async rebaseline() {
    const task = this.active();
    if (!task) return this.noTask();
    task.baseline = await this.baseline();
    await this.save();
    vscode.window.showInformationMessage('已重建任务 Git 基线。');
  }
  async pickFolder() {
    const pick = await vscode.window.showQuickPick(folders().map(folder => ({ label: shortName(folder), folder })), { title: '选择仓库' });
    return pick?.folder;
  }
  noTask() { vscode.window.showInformationMessage('请先创建任务。'); }
  dispose() { clearTimeout(this.refreshTimer); this.gitSubscriptions.forEach(d => d.dispose()); this.emitter.dispose(); }
}

class RepositoriesProvider {
  constructor(model) { this.model = model; this.onDidChangeTreeData = model.onDidChange; }
  getTreeItem(node) { return node.item; }
  async getChildren(node) {
    if (node) return [];
    if (!folders().length) return [{ item: simpleItem('请先打开一个工作区', '', 'folder') }];
    const roots = await Promise.all(folders().map(async folder => {
      const repo = this.model.repoFor(folder);
      const count = this.model.changeCount(folder);
      const head = repo?.state.HEAD;
      const branch = head?.name || (vscode.workspace.isTrusted ? '未发现 Git 仓库' : 'Git 暂不可用');
      const sync = [head?.ahead ? `↑${head.ahead}` : '', head?.behind ? `↓${head.behind}` : ''].filter(Boolean).join(' ');
      const active = this.model.active();
      const scope = active ? ` · ${MODE_TEXT[this.model.scope(active, folder).mode]}` : '';
      const status = repo ? (count ? `${count} 项改动` : '干净') : '状态不可用';
      const item = simpleItem(shortName(folder), `${branch} · ${status}${sync ? ` · ${sync}` : ''}${scope}`, repo ? 'repo' : 'warning');
      const appearance = this.model.appearance(folder);
      if (appearance?.kind === 'image') item.iconPath = vscode.Uri.parse(appearance.value);
      else if (appearance?.kind === 'emoji') item.label = `${appearance.value} ${shortName(folder)}`;
      else if (appearance?.kind === 'icon') item.iconPath = new vscode.ThemeIcon(appearance.value.slice(1));
      item.contextValue = 'awRepository';
      item.tooltip = `${folder.uri.fsPath}\n分支：${branch}\n任务范围：${scope || '无任务'}`;
      item.command = { command: 'agentWorkspace.openFolder', title: '打开文件夹', arguments: [folder] };
      return { item, folder };
    }));
    if (!vscode.workspace.isTrusted) {
      const item = simpleItem('受限模式：Git 状态不可用', '信任工作区后可查看分支和改动', 'lock');
      item.tooltip = 'VS Code 在 Restricted Mode 下未提供 Git 源代码管理。是否信任工作区由你在 VS Code 中决定。';
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
      { item: Object.assign(simpleItem('新建任务', '填写标题、内容和仓库范围', 'add'), { command: { command: 'agentWorkspace.createTask', title: '新建任务' } }) },
      { item: Object.assign(simpleItem('使用说明', '查看完整操作步骤', 'book'), { command: { command: 'agentWorkspace.openGuide', title: '打开使用说明' } }) }
    ];
    if (!node) {
      const active = simpleItem(task.title, contentSummary(task), 'target');
      active.command = { command: 'agentWorkspace.editTask', title: '编辑任务' };
      return [
        { kind: 'header', item: active },
        { kind: 'execute', item: Object.assign(simpleItem('执行', '交给 Copilot Agent', 'play'), { command: { command: 'agentWorkspace.executeTask', title: '执行任务' } }) },
        { kind: 'executions', item: simpleItem('执行记录', `${(task.executions || []).length} 次`, 'history', true) },
        { kind: 'scopes', item: simpleItem('仓库范围', '', 'folder-library', true) },
        { kind: 'conventions', item: simpleItem('项目约定', `${task.conventions.length} 个文件`, 'book', true) },
        { kind: 'changes', item: simpleItem('Git 变更审阅', '', 'git-compare', true) },
        { kind: 'actions', item: simpleItem('操作', '', 'tools', true) }
      ];
    }
    if (node.kind === 'executions') {
      if (!task.executions?.length) return [{ item: simpleItem('暂无执行记录', '点击“执行”后开始记录', 'info') }];
      return task.executions.map(execution => {
        const when = new Date(execution.startedAt).toLocaleString();
        const item = simpleItem(when, `${execution.endedAt ? '已结束观察' : '观察中'} · ${observedCount(execution)} 个文件`, 'history', true);
        item.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
        item.tooltip = `${execution.title}\n${when}\n文件改动仅是执行后观察结果，不能证明均由 Copilot 产生。`;
        return { kind: 'execution', item, execution };
      });
    }
    if (node.kind === 'execution') {
      const execution = node.execution;
      const entries = [
        { item: Object.assign(simpleItem('查看任务内容快照', contentSummary(execution), 'file-text'), { command: { command: 'agentWorkspace.showExecutionDetails', title: '查看执行记录', arguments: [execution] } }) },
        { item: Object.assign(simpleItem('打开 Copilot 会话列表', '按标题和时间查找', 'comment-discussion'), { command: { command: 'agentWorkspace.openCopilotSessions', title: '打开 Copilot 会话列表', arguments: [execution] } }) }
      ];
      if (!execution.endedAt) entries.push({ item: Object.assign(simpleItem('停止记录改动', '不会停止 Copilot', 'stop-circle'), { command: { command: 'agentWorkspace.stopExecutionTracking', title: '停止记录改动', arguments: [execution] } }) });
      const observations = Object.values(execution.observed || {});
      for (const folder of folders()) {
        const rootObservations = observations.filter(observation => observation.root === rootKey(folder));
        const baseline = execution.baseline?.[rootKey(folder)];
        const head = execution.heads?.[rootKey(folder)];
        const headChanged = !!baseline && !!head && (baseline.branch !== head.branch || baseline.commit !== head.commit);
        if (!rootObservations.length && !headChanged) continue;
        const item = simpleItem(shortName(folder), `${rootObservations.length} 个文件${headChanged ? ' · HEAD 已变化' : ''}`, headChanged ? 'warning' : 'repo', true);
        entries.push({ kind: 'executionRoot', item, folder, observations: rootObservations });
      }
      if (!observations.length) entries.push({ item: simpleItem('尚未观察到文件改动', 'Git 状态变化后更新', 'info') });
      return entries;
    }
    if (node.kind === 'executionRoot') return node.observations.map(observation => {
      const kind = { new: '执行后新增', uncertain: '归属不确定', invalid: '基线失效' }[observation.kind] || '执行后观察到';
      const item = simpleItem(observation.key, `${kind}${observation.present ? '' : ' · 当前无 Git 改动'}${observation.warning ? ' · 范围提示' : ''}`, observation.warning ? 'warning' : 'diff');
      item.tooltip = `${observation.warning || '执行后观察到的改动；无法确定是否由 Copilot 产生。'}\n最后观察：${new Date(observation.lastSeenAt).toLocaleString()}`;
      item.command = { command: 'agentWorkspace.openObservedChange', title: '打开记录中的文件', arguments: [observation] };
      return { item };
    });
    if (node.kind === 'scopes') return folders().map(folder => {
      const scope = this.model.scope(task, folder);
      const item = simpleItem(shortName(folder), `${MODE_TEXT[scope.mode]}${scope.directories?.length ? ` · ${scope.directories.length} 个目录` : ''}`, scope.mode === 'write' ? 'edit' : scope.mode === 'read' ? 'eye' : 'circle-slash', !!scope.directories?.length);
      item.command = { command: 'agentWorkspace.setScope', title: '设置范围', arguments: [folder] };
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
        item.command = { command: 'vscode.open', title: '打开约定', arguments: [uri] };
        return { item };
      });
      entries.push({ item: Object.assign(simpleItem('选择 AGENTS.md', '', 'add'), { command: { command: 'agentWorkspace.collectConventions', title: '选择项目约定' } }) });
      return entries;
    }
    if (node.kind === 'changes') return Promise.all(folders().map(async folder => {
      const repo = this.model.repoFor(folder);
      const changes = await this.model.changes(folder);
      const baseline = task.baseline?.[rootKey(folder)];
      const current = this.model.head(repo);
      const invalid = baseline && (baseline.commit !== current.commit || baseline.branch !== current.branch);
      const item = simpleItem(shortName(folder), repo ? `${changes.length} 项${invalid ? ' · 基线失效' : ''}` : 'Git 状态不可用', invalid || !repo ? 'warning' : 'repo', true);
      return { kind: 'changeRoot', item, folder, changes, baseline, invalid, unavailable: !repo };
    }));
    if (node.kind === 'changeRoot') {
      if (node.unavailable) return [{ item: simpleItem('Git 状态不可用', '请检查工作区信任与内置 Git 扩展', 'lock') }];
      if (!node.changes.length) return [{ item: simpleItem('无改动', '', 'check') }];
      return node.changes.map(change => {
        const result = classifyChange(change, node.baseline, this.model.scope(task, node.folder), node.folder.uri.fsPath, node.invalid);
        const kind = { new: '新改动', existing: '任务前已有', uncertain: '归属不确定', invalid: '基线失效' }[result.kind];
        const item = simpleItem(change.key, `${kind}${result.warning ? ' · 超出范围或需重建基线' : ''}`, result.warning ? 'warning' : 'diff');
        item.tooltip = `${kind}\n${result.warning || ''}\nGit 组：${change.group}`;
        item.contextValue = 'awChange';
        item.command = { command: 'agentWorkspace.openChange', title: '打开差异', arguments: [change] };
        return { kind: 'change', item, change };
      });
    }
    if (node.kind === 'actions') return [
      ['编辑任务', 'agentWorkspace.editTask', 'edit'],
      ['添加范围目录', 'agentWorkspace.addDirectory', 'folder-opened'],
      ['复制上下文包', 'agentWorkspace.copyContext', 'copy'],
      ['导出任务 JSON', 'agentWorkspace.exportJson', 'export'],
      ['切换任务', 'agentWorkspace.selectTask', 'list-selection'],
      ['重建 Git 基线', 'agentWorkspace.rebaseline', 'history'],
      ['删除当前任务', 'agentWorkspace.deleteTask', 'trash']
    ].map(([label, command, icon]) => ({ item: Object.assign(simpleItem(label, '', icon), { command: { command, title: label } }) }));
    return [];
  }
}

class PresetsProvider {
  constructor(model) { this.model = model; this.onDidChangeTreeData = model.onDidChange; }
  getTreeItem(node) { return node.item; }
  getChildren(node) {
    if (node) return [];
    if (!this.model.presets.length) return [{ item: simpleItem('暂无预设', '从当前任务保存', 'bookmark') }];
    return this.model.presets.map(preset => {
      const item = simpleItem(preset.name, contentSummary(preset), 'bookmark');
      item.contextValue = 'awPreset';
      item.command = { command: 'agentWorkspace.applyPreset', title: '使用预设', arguments: [preset] };
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
