'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildTheme, emojiSvg, customFileName } = require('../src/rootIcons');

test('root icons apply to both collapsed and expanded Explorer roots', () => {
  const base = { iconDefinitions: { _folder: {} }, rootFolderNames: { old: '_folder' }, rootFolderNamesExpanded: {} };
  const theme = buildTheme(base, [{ name: 'Core', definition: '_folder' }]);
  assert.deepEqual(theme.rootFolderNames, { Core: '_folder' });
  assert.deepEqual(theme.rootFolderNamesExpanded, { Core: '_folder' });
  assert.equal(theme.usesCurrentColor, false);
  assert.deepEqual(base.rootFolderNames, { old: '_folder' });
});

test('emoji icon escapes XML and custom filenames are stable', () => {
  assert.match(emojiSvg('🧪&'), /🧪&amp;/);
  assert.equal(customFileName('root', '.png'), customFileName('root', '.png'));
});
