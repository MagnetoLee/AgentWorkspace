'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

test('task tree shows a saved execution and its Copilot sessions action', async () => {
  const providers = {};
  const execution = { id: 'run-1', title: 'Formula fix', content: 'Fix the formula', startedAt: '2026-10-30T10:00:00Z', endedAt: null, status: 'sent', scopes: {}, conventions: [], baseline: {}, observed: {} };
  const task = { id: 'task-1', title: 'Formula fix', content: 'Fix the formula', scopes: {}, conventions: [], executions: [execution] };
  const state = { 'agentWorkspace.tasks.v1': [task], 'agentWorkspace.activeTask.v1': task.id, 'agentWorkspace.presets.v1': [] };
  const disposable = { dispose() {} };
  const vscode = {
    TreeItemCollapsibleState: { None: 0, Expanded: 1, Collapsed: 2 },
    TreeItem: class { constructor(label, collapsibleState) { this.label = label; this.collapsibleState = collapsibleState; } },
    ThemeIcon: class { constructor(id) { this.id = id; } },
    EventEmitter: class { constructor() { this.event = () => disposable; } fire() {} dispose() {} },
    workspace: { workspaceFolders: [], isTrusted: true, onDidChangeWorkspaceFolders: () => disposable, onDidGrantWorkspaceTrust: () => disposable },
    extensions: { getExtension: () => undefined },
    commands: { registerCommand: () => disposable },
    window: { registerTreeDataProvider: (id, provider) => { providers[id] = provider; return disposable; } }
  };
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) { return request === 'vscode' ? vscode : originalLoad.call(this, request, parent, isMain); };
  try {
    const extension = require('../src/extension');
    await extension.activate({ subscriptions: [], workspaceState: { get: key => state[key], update: async () => {} } });
    const provider = providers['agentWorkspace.tasks'];
    const roots = await provider.getChildren();
    const group = roots.find(node => node.kind === 'executions');
    assert.ok(group);
    const runs = await provider.getChildren(group);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].item.collapsibleState, 2);
    const actions = await provider.getChildren(runs[0]);
    assert.ok(actions.some(node => node.item.command?.command === 'agentWorkspace.openCopilotSessions'));
    assert.ok(actions.some(node => node.item.command?.command === 'agentWorkspace.stopExecutionTracking'));
  } finally { Module._load = originalLoad; }
});
