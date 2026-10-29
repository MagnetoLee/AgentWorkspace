'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { taskFormHtml } = require('../src/taskForm');
const { copilotAgentOptions } = require('../src/handoff');

test('task form keeps title and multiline content editable without HTML injection', () => {
  const html = taskFormHtml({
    title: '修复 <公式> "错误"',
    content: '第一行\n<script>alert(1)</script>',
    roots: [{ index: 0, name: 'Core', key: 'file:///repo', mode: 'write' }],
    nonce: 'nonce', cspSource: 'vscode-webview:', editing: true
  });
  assert.match(html, /value="修复 &lt;公式&gt; &quot;错误&quot;"/);
  assert.match(html, /第一行\n&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /<option value="write" selected>/);
  assert.match(html, /<textarea id="content"/);
});

test('execute uses Copilot model in agent mode and submits the task', () => {
  const options = copilotAgentOptions('# 任务\n\n修复公式模块');
  assert.deepEqual(options, {
    query: '# 任务\n\n修复公式模块',
    mode: 'agent',
    modelSelector: { vendor: 'copilot' },
    isPartialQuery: false
  });
  assert.throws(() => copilotAgentOptions('  '), /任务内容为空/);
});
