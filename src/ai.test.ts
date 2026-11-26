import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseExtraction, extractionJsonSchema, extractionInput } from './ai.js';
import type { AssistantConfig, IntakeProfile } from './config.js';
import type { StoredMessage } from './database.js';
import { splitTextDeterministically } from './qualification.js';

const profile = {
  id: 'triage', label: 'Triagem', triggers: [], fields: [
    { id: 'subject', label: 'Assunto', question: 'Qual assunto?', type: 'open_text', options: [], structure: '', required: true, contactName: false },
    { id: 'city', label: 'Cidade', question: 'Qual cidade?', type: 'open_text', options: [], structure: '', required: true, contactName: false },
  ],
} as IntakeProfile;

const assistant = { maxHistoryMessages: 4, officeMemory: 'texto não deve ser enviado', materials: [{ title: 'interno', content: 'segredo' }] } as AssistantConfig;

test('accepts only configured extraction fields and trims values', () => {
  assert.deepEqual(parseExtraction('{"capturedFields":{"subject":"  Família  "}}', profile), {
    capturedFields: { subject: 'Família' },
  });
});

test('rejects invalid JSON, extra fields, and overlong values', () => {
  assert.throws(() => parseExtraction('texto livre', profile), /JSON inválido/);
  assert.throws(() => parseExtraction('{"capturedFields":{"other":"x"}}', profile), /schema configurado/);
  assert.throws(() => parseExtraction(JSON.stringify({ capturedFields: { subject: 'x'.repeat(501) } }), profile), /schema configurado/);
});

test('extraction schema and input contain only configured intake fields and recent conversation', () => {
  const schema = extractionJsonSchema(profile);
  assert.deepEqual(Object.keys((schema.properties as Record<string, { properties: object }>).capturedFields!.properties), ['subject', 'city']);
  const history = Array.from({ length: 6 }, (_, index) => ({ direction: 'inbound', body: `msg-${index}` } as StoredMessage));
  const input = extractionInput(profile, history, {}, assistant);
  assert.equal(input.includes('msg-0'), false);
  assert.equal(input.includes('msg-5'), true);
  assert.equal(input.includes('segredo'), false);
  assert.equal(input.includes('texto não deve ser enviado'), false);
});

test('splits by sentence, respects message limits, and keeps the final next question', () => {
  const split = splitTextDeterministically([
    'Olá. Sou assistente virtual. Não envie documentos. Compartilhe apenas o necessário.',
    'Qual seu assunto?',
  ], 30, 3);
  assert.equal(split.truncated, true);
  assert.equal(split.messages.length, 3);
  assert.ok(split.messages.every((message) => message.length <= 30));
  assert.equal(split.messages.at(-1), 'Qual seu assunto?');
});

test('splits a single long sentence without exceeding the configured character limit', () => {
  const split = splitTextDeterministically(['palavra '.repeat(25)], 40, 4);
  assert.ok(split.messages.length <= 4);
  assert.ok(split.messages.every((message) => message.length <= 40));
});
