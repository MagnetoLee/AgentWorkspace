'use strict';

function htmlEscape(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

function taskFormHtml({ title, content, roots, nonce, cspSource, editing }) {
  const scopeRows = roots.map(root => `
    <div class="scope">
      <label for="scope-${htmlEscape(root.index)}">${htmlEscape(root.name)}</label>
      <select id="scope-${htmlEscape(root.index)}" data-root="${htmlEscape(root.key)}">
        <option value="none"${root.mode === 'none' ? ' selected' : ''}>Excluded</option>
        <option value="read"${root.mode === 'read' ? ' selected' : ''}>Read only</option>
        <option value="write"${root.mode === 'write' ? ' selected' : ''}>Writable</option>
      </select>
    </div>`).join('');
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);padding:24px;max-width:900px;margin:auto}
h1{font-size:20px;margin:0 0 20px}label{display:block;font-weight:600;margin-bottom:7px}
input,textarea,select{box-sizing:border-box;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,var(--vscode-contrastBorder));border-radius:3px;padding:8px;font:inherit}
input,textarea{width:100%}textarea{min-height:220px;resize:vertical;line-height:1.5}section{margin-bottom:22px}
.hint{color:var(--vscode-descriptionForeground);font-size:12px;margin:6px 0 0}.scope{display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--vscode-panel-border);padding:9px 0;gap:16px}.scope label{margin:0}.scope select{min-width:130px}
button{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:0;border-radius:3px;padding:9px 16px;cursor:pointer;font:inherit}button:hover{background:var(--vscode-button-hoverBackground)}button:disabled{opacity:.6;cursor:wait}
#error{color:var(--vscode-errorForeground);min-height:20px;margin:12px 0}
</style></head><body>
<h1>${editing ? 'Edit Task' : 'New Task'}</h1>
<form id="task-form">
  <section><label for="title">Title</label><input id="title" name="title" maxlength="200" required value="${htmlEscape(title)}" placeholder="For example: Fix the formula module"></section>
  <section><label for="content">Task content</label><textarea id="content" name="content" required placeholder="Describe the work, acceptance criteria, and any constraints">${htmlEscape(content)}</textarea><p class="hint">Use multiple lines if needed. You can edit the task after saving it. Execute sends it to Copilot Agent.</p></section>
  <section><label>Repository scope</label>${scopeRows || '<p class="hint">Open a workspace root first.</p>'}<p class="hint">You can add scope directories from the Task Workspace after saving.</p></section>
  <div id="error" role="alert"></div><button id="save" type="submit">Save Task</button>
</form>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
document.getElementById('task-form').addEventListener('submit', event => {
  event.preventDefault();
  const title = document.getElementById('title').value.trim();
  const content = document.getElementById('content').value.trim();
  if (!title || !content) { document.getElementById('error').textContent = 'Enter a title and task content.'; return; }
  document.getElementById('save').disabled = true;
  const scopes = Object.fromEntries([...document.querySelectorAll('select[data-root]')].map(element => [element.dataset.root, element.value]));
  vscode.postMessage({ type: 'save', title, content, scopes });
});
window.addEventListener('message', event => {
  if (event.data.type === 'error') { document.getElementById('error').textContent = event.data.message; document.getElementById('save').disabled = false; }
});
</script></body></html>`;
}

module.exports = { taskFormHtml, htmlEscape };
