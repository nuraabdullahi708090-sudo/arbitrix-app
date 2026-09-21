'use strict';

/**
 * Default provider: composes the answer from the approved knowledge the
 * retriever selected. Deterministic, offline, and needs no API key - which is
 * why it is the default and why Stage 1 can answer known questions without any
 * external LLM configured.
 *
 * A provider's contract is:
 *   {
 *     name: string,
 *     kind: 'local' | 'http',
 *     requiresApiKey: boolean,
 *     available: boolean,
 *     async generate({ question, hits, instructions }) ->
 *       { text: string|null, noAnswer?: boolean, provider, model }
 *   }
 */

function createKnowledgeProvider() {
  return {
    name: 'knowledge',
    kind: 'local',
    requiresApiKey: false,
    available: true,
    async generate({ hits } = {}) {
      const list = Array.isArray(hits) ? hits : [];
      if (list.length === 0) return { text: null, noAnswer: true, provider: 'knowledge', model: null };
      // Prefer an informational entry; a guardrail entry is also answerable.
      const chosen = list.find((h) => h.kind === 'info') || list[0];
      return { text: chosen.answer, noAnswer: false, provider: 'knowledge', model: null, entryId: chosen.id };
    }
  };
}

module.exports = { createKnowledgeProvider };
