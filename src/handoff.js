'use strict';

function copilotAgentOptions(query) {
  if (!query || !query.trim()) throw new Error('Task content is empty');
  return { query, mode: 'agent', modelSelector: { vendor: 'copilot' }, isPartialQuery: false };
}

module.exports = { copilotAgentOptions };
