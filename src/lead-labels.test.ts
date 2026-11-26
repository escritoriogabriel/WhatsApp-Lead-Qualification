import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ensureNewLeadLists } from './lead-labels.js';

test('does not add bot lists when Clientes is present, even if Bot is also applied', async () => {
  let called = false;
  const result = await ensureNewLeadLists(['Bot - atendimento', 'Clientes'], async () => { called = true; });
  assert.equal(result, 'blocked-by-clients');
  assert.equal(called, false);
});

test('adds both lists when either one is missing and avoids redundant provider writes', async () => {
  let writes = 0;
  assert.equal(await ensureNewLeadLists(['Bot - atendimento'], async () => { writes += 1; }), 'lists-added');
  assert.equal(await ensureNewLeadLists([' Novo Lead '], async () => { writes += 1; }), 'lists-added');
  assert.equal(await ensureNewLeadLists(['novo lead', 'BOT - ATENDIMENTO'], async () => { writes += 1; }), 'lists-already-present');
  assert.equal(writes, 2);
});
