'use strict';

function copilotAgentOptions(query) {
  if (!query || !query.trim()) throw new Error('任务内容为空');
  return { query, mode: 'agent', modelSelector: { vendor: 'copilot' }, isPartialQuery: false };
}

module.exports = { copilotAgentOptions };
