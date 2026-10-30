'use strict';

const crypto = require('node:crypto');

const ICONS = [
  ['_folder', 'Folder'], ['_git', 'Git'], ['_github', 'GitHub'],
  ['_image', 'Image'], ['_notebook', 'Notebook'], ['_project', 'Project'],
  ['_settings', 'Settings'], ['_pipeline', 'Pipeline']
];

function escapeXml(value) {
  return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character]);
}

function emojiSvg(value) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><text x="16" y="25" text-anchor="middle" font-size="25" font-family="Apple Color Emoji,Segoe UI Emoji,Noto Color Emoji">${escapeXml(value)}</text></svg>`;
}

function customFileName(key, extension) {
  return `${crypto.createHash('sha256').update(key).digest('hex').slice(0, 16)}${extension}`;
}

function buildTheme(base, entries) {
  const theme = structuredClone(base);
  theme.usesCurrentColor = false;
  theme.rootFolder = theme.folder;
  theme.rootFolderExpanded = theme.folderExpanded;
  theme.rootFolderNames = {};
  theme.rootFolderNamesExpanded = {};
  theme.folderNames = { ...theme.folderNames };
  theme.folderNamesExpanded = { ...theme.folderNamesExpanded };
  for (const { name, definition } of entries) {
    theme.rootFolderNames[name] = definition;
    theme.rootFolderNamesExpanded[name] = definition;
    theme.folderNames[name] = definition;
    theme.folderNamesExpanded[name] = definition;
  }
  return theme;
}

module.exports = { ICONS, emojiSvg, customFileName, buildTheme };
