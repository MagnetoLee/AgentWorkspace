'use strict';

function htmlEscape(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

function taskFormHtml({ title, content, roots, nonce, cspSource, editing }) {
  const scopeRows = roots.map(root => `
    <div class="scope">
      <label for="scope-${htmlEscape(root.index)}">${htmlEscape(root.name)}</label>
      <select id="scope-${htmlEscape(root.index)}" data-root="${htmlEscape(root.key)}">
        <option value="none"${root.mode === 'none' ? ' selected' : ''}>未纳入</option>
        <option value="read"${root.mode === 'read' ? ' selected' : ''}>只读</option>
        <option value="write"${root.mode === 'write' ? ' selected' : ''}>可改</option>
      </select>
    </div>`).join('');
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8">
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
<h1>${editing ? '编辑任务' : '新建任务'}</h1>
<form id="task-form">
  <section><label for="title">标题</label><input id="title" name="title" maxlength="200" required value="${htmlEscape(title)}" placeholder="例如：修复公式模块缺陷"></section>
  <section><label for="content">任务内容</label><textarea id="content" name="content" required placeholder="描述要完成的工作、验收标准和注意事项">${htmlEscape(content)}</textarea><p class="hint">支持多行文字。保存后可再次编辑，执行时会发送给 Copilot Agent。</p></section>
  <section><label>仓库范围</label>${scopeRows || '<p class="hint">请先打开工作区根目录。</p>'}<p class="hint">目录范围可在保存后从任务工作台继续添加。</p></section>
  <div id="error" role="alert"></div><button id="save" type="submit">保存任务</button>
</form>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
document.getElementById('task-form').addEventListener('submit', event => {
  event.preventDefault();
  const title = document.getElementById('title').value.trim();
  const content = document.getElementById('content').value.trim();
  if (!title || !content) { document.getElementById('error').textContent = '请填写标题和任务内容。'; return; }
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
