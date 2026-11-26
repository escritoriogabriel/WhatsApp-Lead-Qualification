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

const inbound = (body: string) => [{ direction: 'inbound', body } as StoredMessage];

test('accepts only configured extraction fields when values are grounded in inbound text', () => {
  assert.deepEqual(parseExtraction('{"capturedFields":{"subject":"  Família  "}}', profile, inbound('Preciso de ajuda com Família.')), {
    capturedFields: { subject: 'Família' },
  });
});

test('drops values invented by the model and values that only appear in assistant messages', () => {
  const history = [
    { direction: 'inbound', body: 'Preciso de ajuda com trabalho.' },
    { direction: 'outbound', body: 'Qual cidade? Recife?' },
  ] as StoredMessage[];
  assert.deepEqual(parseExtraction('{"capturedFields":{"subject":"Família","city":"Recife"}}', profile, history), {
    capturedFields: {},
  });
});

test('validates yes/no and choice fields against their configured answers', () => {
  const typedProfile = {
    ...profile,
    fields: [
      { ...profile.fields[0]!, id: 'deadline', type: 'yes_no' },
      { ...profile.fields[1]!, id: 'area', type: 'single_choice', options: ['Trabalhista', 'Família'] },
    ],
  } as IntakeProfile;
  assert.deepEqual(parseExtraction('{"capturedFields":{"deadline":"Sim!","area":"Trabalhista"}}', typedProfile, inbound('Sim! Quero atendimento Trabalhista.')), {
    capturedFields: { deadline: 'sim', area: 'Trabalhista' },
  });
  assert.deepEqual(parseExtraction('{"capturedFields":{"deadline":"talvez","area":"Criminal"}}', typedProfile, inbound('Talvez, é um caso Criminal.')), {
    capturedFields: {},
  });
});

test('does not accept a service request as a contact name', () => {
  const nameProfile = {
    ...profile,
    fields: [{ ...profile.fields[0]!, id: 'name', label: 'Nome', contactName: true }],
  } as IntakeProfile;
  assert.deepEqual(parseExtraction('{"capturedFields":{"name":"Quero conversar com um advogado"}}', nameProfile, inbound('Quero conversar com um advogado.')), {
    capturedFields: {},
  });
  assert.deepEqual(parseExtraction('{"capturedFields":{"name":"Meu nome é Ana"}}', nameProfile, inbound('Meu nome é Ana.')), {
    capturedFields: { name: 'Ana' },
  });
});

test('rejects invalid JSON, extra fields, and overlong values', () => {
  assert.throws(() => parseExtraction('texto livre', profile, []), /JSON inválido/);
  assert.throws(() => parseExtraction('{"capturedFields":{"other":"x"}}', profile, []), /schema configurado/);
  assert.throws(() => parseExtraction(JSON.stringify({ capturedFields: { subject: 'x'.repeat(501) } }), profile, []), /schema configurado/);
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
