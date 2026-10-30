'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { taskFormHtml } = require('../src/taskForm');
const { copilotAgentOptions } = require('../src/handoff');

test('task form keeps title and multiline content editable without HTML injection', () => {
  const html = taskFormHtml({
    title: 'Fix <formula> "error"',
    content: 'First line\n<script>alert(1)</script>',
    roots: [{ index: 0, name: 'Core', key: 'file:///repo', mode: 'write' }],
    nonce: 'nonce', cspSource: 'vscode-webview:', editing: true
  });
  assert.match(html, /value="Fix &lt;formula&gt; &quot;error&quot;"/);
  assert.match(html, /First line\n&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /<option value="write" selected>/);
  assert.match(html, /<textarea id="content"/);
});

test('execute uses Copilot model in agent mode and submits the task', () => {
  const options = copilotAgentOptions('# Task\n\nFix formula module');
  assert.deepEqual(options, {
    query: '# Task\n\nFix formula module',
    mode: 'agent',
    modelSelector: { vendor: 'copilot' },
    isPartialQuery: false
  });
  assert.throws(() => copilotAgentOptions('  '), /Task content is empty/);
});
