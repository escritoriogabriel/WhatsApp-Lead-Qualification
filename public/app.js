'use strict';

const byId = (id) => document.getElementById(id);
const content = byId('content');
const app = byId('app');
const login = byId('login');

const TITLES = {
  overview: 'Visão geral',
  messages: 'Mensagens padrão',
  flow: 'Fluxos e perguntas',
  events: 'Eventos e condições',
  knowledge: 'Estilo e materiais',
  preview: 'Testar conversa',
  whatsapp: 'Conexão WhatsApp',
  lists: 'Regras das listas',
  diagnostics: 'Fila e diagnósticos',
};

const state = { config: null, page: 'overview', profileIndex: 0, dirty: false, poller: null };
let sim = null;

/* ------------------------------------------------------------------ API */

async function api(path, options = {}) {
  const isForm = typeof FormData !== 'undefined' && options.body instanceof FormData;
  const response = await fetch(path, {
    credentials: 'same-origin',
    ...options,
    headers: { ...(options.body && !isForm ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) },
  });
  const payload = response.status === 204 ? {} : await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || `Falha na solicitação (${response.status}).`);
    error.details = payload.details || [];
    throw error;
  }
  return payload;
}

/* -------------------------------------------------------------- helpers */

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}
function listToText(value) { return (value || []).join('\n'); }
function textToList(value) { return String(value || '').split('\n').map((item) => item.trim()).filter(Boolean); }
function getPath(path) { return path.split('.').reduce((acc, key) => (acc == null ? acc : acc[key]), state.config); }
function setPath(path, value) {
  const parts = path.split('.');
  let target = state.config;
  for (const part of parts.slice(0, -1)) {
    if (target[part] === undefined || target[part] === null) target[part] = {};
    target = target[part];
  }
  target[parts.at(-1)] = value;
  markDirty();
}
function markDirty() {
  state.dirty = true;
  byId('save-state').textContent = 'Alterações não salvas';
  byId('save-state').classList.add('dirty');
}
function toast(message, isError = false) {
  const el = byId('toast');
  el.textContent = message;
  el.classList.toggle('error', isError);
  el.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove('show'), 3600);
}

/* ----------------------------------------------------- form components */

function field(label, path, value, options = {}) {
  const { type = 'text', help = '', max = null, rows = 4, placeholder = '', full = true, step = null, min = null, maxValue = null } = options;
  const id = `f-${path.replace(/[^a-z0-9]+/gi, '-')}`;
  const helpHtml = help ? `<small class="help">${escapeHtml(help)}</small>` : '';
  const counter = max ? `<small class="count" data-counter-for="${id}">0/${max}</small>` : '';
  const common = `id="${id}" data-path="${path}"`;
  let control;
  if (type === 'textarea') {
    control = `<textarea ${common} rows="${rows}" maxlength="${max || 4000}" placeholder="${escapeHtml(placeholder)}">${escapeHtml(value)}</textarea>`;
  } else if (type === 'number') {
    control = `<input ${common} type="number" step="${step || 1}"${min !== null ? ` min="${min}"` : ''}${maxValue !== null ? ` max="${maxValue}"` : ''} value="${escapeHtml(value)}" />`;
  } else {
    control = `<input ${common} type="text" maxlength="${max || 500}" placeholder="${escapeHtml(placeholder)}" value="${escapeHtml(value)}" />`;
  }
  return `<div class="field${full ? ' full' : ''}"><label for="${id}">${escapeHtml(label)}</label>${control}${helpHtml}${counter}</div>`;
}

function selectField(label, path, value, options, help = '') {
  const id = `f-${path.replace(/[^a-z0-9]+/gi, '-')}`;
  return `<div class="field"><label for="${id}">${escapeHtml(label)}</label><select id="${id}" data-path="${path}">${options
    .map(([optionValue, optionLabel]) => `<option value="${escapeHtml(optionValue)}" ${optionValue === value ? 'selected' : ''}>${escapeHtml(optionLabel)}</option>`)
    .join('')}</select>${help ? `<small class="help">${escapeHtml(help)}</small>` : ''}</div>`;
}

function switchField(label, path, checked, help = '') {
  return `<div class="switch-row"><div class="switch-copy"><strong>${escapeHtml(label)}</strong>${help ? `<small>${escapeHtml(help)}</small>` : ''}</div><label class="switch"><input type="checkbox" data-path="${path}" ${checked ? 'checked' : ''}><span></span></label></div>`;
}

function heading(kicker, title, description, action = '') {
  return `<div class="page-heading${action ? ' with-action' : ''}"><div><p class="eyebrow">${escapeHtml(kicker)}</p><h1>${escapeHtml(title)}</h1><p class="lede">${escapeHtml(description)}</p></div>${action}</div>`;
}

function card(title, description, body, actions = '') {
  return `<section class="card"><div class="card-head"><div><h2>${escapeHtml(title)}</h2>${description ? `<p class="card-desc">${escapeHtml(description)}</p>` : ''}</div>${actions}</div>${body}</section>`;
}

function guide(title, items) {
  return `<div class="guide"><strong class="title">${escapeHtml(title)}</strong><ol class="steps">${items
    .map((item) => `<li><span>${item}</span></li>`)
    .join('')}</ol></div>`;
}

/* ------------------------------------------------------------ rendering */

function render() {
  if (state.poller) { clearInterval(state.poller); state.poller = null; }
  byId('page-title').textContent = TITLES[state.page] || 'Painel';
  document.querySelectorAll('.nav-item').forEach((item) => item.classList.toggle('active', item.dataset.page === state.page));
  if (state.page === 'overview') renderOverview();
  if (state.page === 'messages') renderMessages();
  if (state.page === 'flow') renderFlow();
  if (state.page === 'events') renderEvents();
  if (state.page === 'knowledge') renderKnowledge();
  if (state.page === 'preview') renderPreview();
  if (state.page === 'whatsapp') renderWhatsApp();
  if (state.page === 'lists') renderLists();
  if (state.page === 'diagnostics') void renderDiagnostics();
  bindContent();
}

function bindContent() {
  content.querySelectorAll('[data-path]').forEach((element) => {
    const isChoice = element.tagName === 'SELECT' || element.type === 'checkbox' || element.type === 'number';
    element.addEventListener(isChoice ? 'change' : 'input', () => {
      const value = element.type === 'checkbox' ? element.checked : element.type === 'number' ? Number(element.value) : element.value;
      setPath(element.dataset.path, value);
      afterFieldChange(element.dataset.path);
    });
  });
  content.querySelectorAll('[data-list-path]').forEach((element) => {
    element.addEventListener('input', () => {
      setPath(element.dataset.listPath, textToList(element.value));
      afterFieldChange(element.dataset.listPath);
    });
  });
  content.querySelectorAll('[data-action]').forEach((element) => {
    element.addEventListener('click', () => handleAction(element.dataset.action, element));
  });
  content.querySelectorAll('[data-page]').forEach((element) => {
    element.addEventListener('click', () => { state.page = element.dataset.page; render(); });
  });
  attachCounters();
}

function afterFieldChange(path) {
  if (state.page === 'messages' && ['greeting', 'assistantNotice', 'privacyNotice', 'externalProviderNotice', 'maxCharsPerMessage'].includes(path)) refreshOpeningPreview();
  if (path.endsWith('.type')) renderFlow();
  if (path.endsWith('.trigger') || path.endsWith('.action')) renderEvents();
  const panel = byId('validation-errors');
  if (!panel.classList.contains('hidden')) validateBeforeSave(false);
}

function attachCounters() {
  content.querySelectorAll('[data-counter-for]').forEach((counter) => {
    const input = byId(counter.dataset.counterFor);
    if (!input) return;
    const max = Number(input.getAttribute('maxlength') || 0);
    const update = () => {
      counter.textContent = `${input.value.length}/${max}`;
      counter.classList.toggle('over', max > 0 && input.value.length > max);
    };
    input.addEventListener('input', update);
    update();
  });
}

/* ------------------------------------------------------------- overview */

function renderOverview() {
  const config = state.config;
  const profile = config.profiles.find((item) => item.id === config.defaultProfileId) || config.profiles[0];
  const events = config.conditionalEvents || [];
  const activeEvents = events.filter((event) => event.enabled).length;
  const aiLabel = config.aiProvider === 'gemini' ? 'Gemini externo' : 'Ollama local';

  content.innerHTML =
    heading('Painel do escritório', 'Seu atendimento no WhatsApp, do primeiro oi ao encaminhamento.', 'Tudo o que o contato recebe é texto fixo aprovado aqui. A IA apenas organiza as respostas recebidas e a equipe decide o resto.') +
    `<div class="stat-grid">
      <div class="stat"><div class="stat-label">Fluxos ativos</div><div class="stat-value">${config.profiles.length}</div><div class="stat-note">${escapeHtml(profile?.label || '—')} é o padrão</div></div>
      <div class="stat"><div class="stat-label">Perguntas padrão</div><div class="stat-value">${profile?.fields.length || 0}</div><div class="stat-note">na triagem padrão</div></div>
      <div class="stat"><div class="stat-label">Eventos ativos</div><div class="stat-value">${activeEvents}</div><div class="stat-note">de ${events.length} cadastrados</div></div>
      <div class="stat"><div class="stat-label">Balão</div><div class="stat-value text">${config.maxCharsPerMessage} caracteres</div><div class="stat-note">até ${config.maxMessagesPerTurn} balões por turno</div></div>
    </div>` +
    `<div class="grid two section-gap">
      <section class="card">
        <div class="card-head"><div><h2>Comece por aqui</h2><p class="card-desc">A ordem abaixo evita mensagens estranhas no atendimento real.</p></div></div>
        ${guide('Roteiro de configuração', [
          '<strong>Mensagens padrão</strong> — escreva a saudação, a confirmação e o encerramento com o seu tom.',
          '<strong>Fluxos e perguntas</strong> — defina quais informações a triagem precisa antes de encaminhar.',
          '<strong>Estilo e materiais</strong> — importe um TXT de conversa real para a IA aprender como você fala.',
          '<strong>Testar conversa</strong> — simule o atendimento e ajuste o que soar artificial.',
          '<strong>Conexão WhatsApp</strong> — confirme a sessão e as listas antes de atender de verdade.',
        ])}
        <div class="button-row mt-14">
          <button class="button primary" data-page="preview">Testar conversa</button>
          <button class="button" data-page="messages">Revisar mensagens</button>
          <button class="button" data-action="apply-template">Aplicar modelo de escritório</button>
        </div>
      </section>
      <section class="card">
        <div class="card-head"><div><h2>Como a conversa funciona</h2><p class="card-desc">Regras fixas que protegem o escritório.</p></div></div>
        <ol class="steps">
          <li><span>O contato escreve. O agente só responde se a etiqueta <span class="code">Bot - atendimento</span> estiver aplicada e <span class="code">Clientes</span> não estiver.</span></li>
          <li><span>Com Gemini ativo, a primeira mensagem do contato não é enviada à IA: o aviso de processamento sai antes.</span></li>
          <li><span>A IA apenas extrai campos com trecho literal. Se não conseguir, o bot pede esclarecimento ou encaminha.</span></li>
          <li><span>Ao concluir, o contato recebe a mensagem de encerramento e a etiqueta muda para <span class="code">Atendimento</span>.</span></li>
        </ol>
        <div class="notice green mt-14">Assunto que exija orientação jurídica, urgência ou pedido de humano vai direto para a equipe — sem resposta automática inventada.</div>
      </section>
    </div>` +
    `<div class="grid two section-gap">
      <section class="card">
        <div class="card-head"><div><h2>Inteligência artificial</h2><p class="card-desc">A IA não redige mensagens ao contato em nenhum modo.</p></div></div>
        <div class="field-grid">
          ${selectField('Provedor de extração', 'aiProvider', config.aiProvider, [['gemini', 'Gemini (externo)'], ['ollama', 'Ollama (local)']], 'Gemini envia apenas as mensagens recebidas após o aviso. O Ollama local não sai da máquina.')}
          ${selectField('Transcrição de áudio', 'audioTranscriptionProvider', config.audioTranscriptionProvider, [['disabled', 'Desativada'], ['gemini', 'Gemini (externo)']], 'Desativada, todo áudio é encaminhado à equipe sem transcrição.')}
        </div>
        <div class="notice mt-14">Modelo em uso: <b>${escapeHtml(aiLabel)}</b>. A troca de modelo é feita por variável de ambiente, não pelo painel.</div>
      </section>
      <section class="card">
        <div class="card-head"><div><h2>Resumo do fluxo padrão</h2><p class="card-desc">${escapeHtml(profile?.label || '')}</p></div><button class="button small" data-page="flow">Editar</button></div>
        <ol class="steps">
          ${(profile?.fields || []).map((item) => `<li><span><strong>${escapeHtml(item.label)}</strong> — ${escapeHtml(item.question)}</span></li>`).join('')}
        </ol>
      </section>
    </div>`;
}

/* ------------------------------------------------------------- messages */

const GREETING_PRESETS = [
  { label: 'Acolhedora', text: 'Olá! Aqui é o atendimento do escritório. Que bom falar com você. Vou fazer algumas perguntas rápidas para a equipe entender o seu caso e retornar com a orientação certa. Se preferir falar com uma pessoa, escreva HUMANO a qualquer momento.' },
  { label: 'Formal', text: 'Olá. Aqui é o canal de atendimento inicial do escritório. Para direcionar o seu relato à equipe responsável, farei algumas perguntas objetivas. Se preferir o atendimento humano, escreva HUMANO.' },
  { label: 'Objetiva', text: 'Olá! Sou o atendimento virtual do escritório. Vou fazer 4 perguntas rápidas para encaminhar seu caso à equipe. Escreva HUMANO se quiser falar com uma pessoa.' },
];

function renderMessages() {
  const config = state.config;
  const fields = (config.profiles.find((item) => item.id === config.defaultProfileId) || config.profiles[0])?.fields || [];

  content.innerHTML =
    heading('Mensagens padrão', 'A primeira impressão do escritório está aqui.', 'Estes textos são enviados ao contato exatamente como escritos. A IA nunca escreve para o cliente — por isso, cada momento da conversa tem uma mensagem própria.') +
    `<div class="grid two">
      <section class="card">
        <div class="card-head"><div><h2>Identidade do escritório</h2><p class="card-desc">Aparece nas mensagens e no resumo enviado à equipe.</p></div></div>
        <div class="field-grid">
          ${field('Nome do escritório', 'officeName', config.officeName, { full: false, max: 120, help: 'Como o escritório se apresenta ao contato.' })}
          ${field('Nome do assistente', 'assistantName', config.assistantName, { full: false, max: 120, help: 'Use um nome simples, como “Assistente virtual do escritório”.' })}
        </div>
      </section>
      <section class="card">
        <div class="card-head"><div><h2>Como a abertura é montada</h2><p class="card-desc">Saudação + aviso de assistente + privacidade, divididos em balões.</p></div></div>
        <div id="opening-preview"></div>
        <p class="card-desc mt-10">A primeira mensagem do contato nunca chega à IA. O aviso externo é enviado antes de qualquer processamento.</p>
      </section>
    </div>` +
    card('Saudação e abertura', 'Sempre enviada apenas como resposta a uma mensagem recebida: o agente nunca inicia conversa.', `
      <div class="field-grid">
        <div class="field full">
          <label for="f-greeting">Mensagem de abertura</label>
          <textarea id="f-greeting" data-path="greeting" rows="4" maxlength="1000">${escapeHtml(config.greeting)}</textarea>
          <small class="help">Cumprimente, diga o que vai acontecer e lembre que existe atendimento humano.</small>
          <small class="count" data-counter-for="f-greeting">0/1000</small>
          <div class="chip-row mt-4">${GREETING_PRESETS.map((preset, index) => `<button type="button" class="chip" data-action="greeting-preset" data-index="${index}">Usar cumprimento ${escapeHtml(preset.label.toLowerCase())}</button>`).join('')}</div>
        </div>
        ${field('Aviso de assistente virtual', 'assistantNotice', config.assistantNotice, { type: 'textarea', rows: 3, max: 500, help: 'Deixe explícito que não é advogado e que não há consulta jurídica.' })}
        ${field('Aviso de privacidade', 'privacyNotice', config.privacyNotice, { type: 'textarea', rows: 3, max: 1000, help: 'Peça só o necessário e evite documentos nesta etapa.' })}
        ${field('Aviso de processamento externo', 'externalProviderNotice', config.externalProviderNotice, { type: 'textarea', rows: 3, max: 1000, help: 'Enviado antes de qualquer conteúdo ir ao Gemini. Precisa caber em um balão.' })}
        ${field('Pergunta da área', 'areaQuestion', config.areaQuestion, { type: 'textarea', rows: 2, max: 500, help: 'Pergunta usada quando a área ainda não foi informada.' })}
        ${selectField('Campo que guarda a área', 'areaFieldId', config.areaFieldId, fields.map((item) => [item.id, item.label]), 'Precisa existir como campo obrigatório em todos os fluxos.')}
      </div>`) +
    `<div class="grid two section-gap">
      <section class="card">
        <div class="card-head"><div><h2>Durante a conversa</h2><p class="card-desc">Respostas curtas para não repetir perguntas.</p></div></div>
        <div class="field-grid">
          ${field('Confirmação após uma resposta', 'acknowledgementMessage', config.acknowledgementMessage, { type: 'textarea', rows: 2, max: 300, help: 'Vai junto com a próxima pergunta. Mantenha curta.' })}
          ${field('Pedido de esclarecimento', 'clarificationMessage', config.clarificationMessage, { type: 'textarea', rows: 3, max: 1000, help: 'Usada quando a resposta não corresponde à pergunta feita.' })}
        </div>
      </section>
      <section class="card">
        <div class="card-head"><div><h2>Encerramento e exceções</h2><p class="card-desc">Textos de saída segura: nunca prometem resultado.</p></div></div>
        <div class="field-grid">
          ${field('Triagem concluída', 'completionMessage', config.completionMessage, { type: 'textarea', rows: 3, max: 1000, help: 'Diga que o relato será encaminhado e em qual horário a equipe responde.' })}
          ${field('Encaminhamento para a equipe', 'handoffMessage', config.handoffMessage, { type: 'textarea', rows: 3, max: 1000, help: 'Usada em dúvida jurídica, pedido de humano e baixa confiança.' })}
          ${field('Urgência detectada', 'urgencyMessage', config.urgencyMessage, { type: 'textarea', rows: 3, max: 1000, help: 'A triagem para e o contato recebe esta mensagem.' })}
          ${field('Falha da IA', 'aiFallbackMessage', config.aiFallbackMessage, { type: 'textarea', rows: 3, max: 1000, help: 'Nunca invente uma resposta: encaminhe.' })}
          ${field('Áudio sem transcrição', 'audioRetryMessage', config.audioRetryMessage, { type: 'textarea', rows: 2, max: 1000, help: 'Pede o relato por escrito.' })}
        </div>
      </section>
    </div>` +
    card('Comportamento do envio', 'Ritmo das mensagens e limites de segurança por contato.', `
      <div class="field-grid">
        ${field('Caracteres por balão', 'maxCharsPerMessage', config.maxCharsPerMessage, { type: 'number', full: false, min: 80, maxValue: 4000, help: 'Textos maiores são divididos em balões.' })}
        ${field('Máximo de balões por turno', 'maxMessagesPerTurn', config.maxMessagesPerTurn, { type: 'number', full: false, min: 1, maxValue: 4, help: 'Excedentes são omitidos e registrados no diagnóstico.' })}
        ${field('Aguardar mensagens por', 'batchWindowSeconds', config.batchWindowSeconds, { type: 'number', full: false, min: 0, step: 0.5, help: 'Segundos — agrupa mensagens enviadas em sequência.' })}
        ${field('Intervalo entre balões (s)', 'sendPartDelaySeconds', config.sendPartDelaySeconds, { type: 'number', full: false, min: 0, step: 0.1 })}
        ${field('Tentativas por pergunta', 'maxFieldAttempts', config.maxFieldAttempts, { type: 'number', full: false, min: 1, maxValue: 5, help: 'Depois disso, a triagem é encaminhada ou o campo é pulado.' })}
        ${field('Retenção de dados (dias)', 'retentionDays', config.retentionDays, { type: 'number', full: false, min: 1, maxValue: 3650 })}
      </div>
      <div class="rule"></div>
      ${switchField('Simular “digitando…”', 'simulateTyping', config.simulateTyping, 'Mostra presença de digitação antes de cada balão. O atraso nunca passa de 8 segundos.')}
      ${field('Segundos de digitação por caractere', 'typingSecondsPerCharacter', config.typingSecondsPerCharacter, { type: 'number', full: false, min: 0, maxValue: 1, step: 0.005, help: 'Valores altos deixam o atendimento lento. Recomendado entre 0,015 e 0,03.' })}
    <div class="field full">
      <label for="f-humanCommand">Comando de atendimento humano</label>
      <input id="f-humanCommand" data-path="humanCommand" value="${escapeHtml(config.humanCommand)}" maxlength="40" />
      <small class="help">Palavra que o contato escreve para falar com uma pessoa. Ex.: HUMANO.</small>
    </div>`);

  refreshOpeningPreview();
}

function openingBubbles() {
  const config = state.config;
  const parts = [config.greeting, config.assistantNotice, config.privacyNotice].filter(Boolean);
  return splitBubbles(parts);
}

function refreshOpeningPreview() {
  const target = byId('opening-preview');
  if (!target) return;
  const bubbles = openingBubbles();
  target.innerHTML = `<div class="message-preview">${bubbles.map((text) => `<div class="bubble">${escapeHtml(text)}</div>`).join('')}</div>`;
}

/* ---------------------------------------------------------------- flows */

function renderFlow() {
  const config = state.config;
  if (!config.profiles.length) config.profiles = [{ id: 'triagem', label: 'Nova área', triggers: [], fields: [] }];
  state.profileIndex = Math.min(state.profileIndex, config.profiles.length - 1);
  const index = state.profileIndex;
  const profile = config.profiles[index];

  content.innerHTML =
    heading('Fluxos e perguntas', 'Pergunte apenas o que ajuda a equipe a agir.', 'Cada área pode ter perguntas próprias. As perguntas são feitas na ordem abaixo, respeitando as condições configuradas.') +
    `<div class="profile-bar">
      <select id="profile-select" class="inline-select" aria-label="Área em edição">${config.profiles.map((item, itemIndex) => `<option value="${itemIndex}" ${itemIndex === index ? 'selected' : ''}>${escapeHtml(item.label)}</option>`).join('')}</select>
      <button class="button small" data-action="add-profile">Nova área</button>
      <button class="button small danger" data-action="remove-profile">Remover área</button>
      <div class="spacer"></div>
      <label class="checkline"><input type="radio" name="default-profile" data-action="make-default" ${profile.id === config.defaultProfileId ? 'checked' : ''}> Área padrão da triagem</label>
    </div>` +
    card('Identificação da área', 'Palavras-gatilho fazem a conversa migrar para esta área quando o contato as menciona.', `
      <div class="field-grid">
        ${field('Nome da área', 'profiles.' + index + '.label', profile.label, { full: false, max: 120 })}
        ${field('Identificador', 'profiles.' + index + '.id', profile.id, { full: false, max: 64, help: 'Sem espaços. Alterar o identificador reinicia a área padrão se ela apontar para ele.' })}
        <div class="field full">
          <label for="f-triggers">Palavras para reconhecer esta área</label>
          <textarea id="f-triggers" data-list-path="profiles.${index}.triggers" rows="3" placeholder="trabalhista&#10;demissão&#10;horas extras">${escapeHtml(listToText(profile.triggers))}</textarea>
          <small class="help">Uma por linha. Se a mensagem inicial contiver uma delas, esta área é escolhida automaticamente.</small>
        </div>
      </div>`) +
    `<section class="card section-gap">
      <div class="card-head">
        <div><h2>Perguntas da área</h2><p class="card-desc">${profile.fields.length} pergunta(s). A primeira precisa ser a área, porque ela define o fluxo.</p></div>
        <button class="button small" data-action="add-field">Adicionar pergunta</button>
      </div>
      ${profile.fields.map((item, fieldIndex) => questionCard(item, fieldIndex, profile)).join('') || '<div class="empty-state">Adicione a primeira pergunta desta área.</div>'}
    </section>`;

  const profileSelect = byId('profile-select');
  if (profileSelect) profileSelect.addEventListener('change', () => { state.profileIndex = Number(profileSelect.value); renderFlow(); bindContent(); });
  content.querySelectorAll('[data-action="make-default"]').forEach((radio) => radio.addEventListener('change', () => { config.defaultProfileId = profile.id; markDirty(); }));
}

function questionCard(item, index, profile) {
  const base = `profiles.${state.profileIndex}.fields.${index}`;
  const typeOptions = [['open_text', 'Resposta aberta'], ['yes_no', 'Sim ou não'], ['single_choice', 'Escolha única'], ['multiple_choice', 'Múltipla escolha'], ['date', 'Data'], ['number', 'Número']];
  const isChoice = ['single_choice', 'multiple_choice'].includes(item.type);
  const conditionOptions = [['', 'Sempre perguntar'], ...profile.fields.filter((other) => other.id !== item.id).map((other) => [other.id, `Quando “${other.label}” = ...`])];
  const meta = [
    `<span class="badge">${escapeHtml(typeOptions.find(([value]) => value === item.type)?.[1] || item.type)}</span>`,
    item.required ? '<span class="badge green">Obrigatória</span>' : '<span class="badge gray">Opcional</span>',
    item.contactName ? '<span class="badge amber">Renomeia o contato</span>' : '',
    item.askWhen?.fieldId ? `<span class="badge amber">Condicional: ${escapeHtml(item.askWhen.fieldId)} = ${escapeHtml(item.askWhen.value)}</span>` : '',
  ].join('');

  return `<div class="question-card">
    <div class="question-head">
      <span class="question-index">${String(index + 1).padStart(2, '0')}</span>
      <span class="question-title">${escapeHtml(item.label || 'Nova pergunta')}</span>
      <button class="button small" data-action="up-field" data-index="${index}" ${index === 0 ? 'disabled' : ''} title="Subir">↑</button>
      <button class="button small" data-action="down-field" data-index="${index}" ${index === profile.fields.length - 1 ? 'disabled' : ''} title="Descer">↓</button>
      <button class="button small danger" data-action="remove-field" data-index="${index}">Remover</button>
    </div>
    <div class="question-meta">${meta}</div>
    <div class="field-grid">
      ${field('Pergunta enviada ao contato', base + '.question', item.question, { type: 'textarea', rows: 2, max: 500, help: 'Uma pergunta por vez. Evite duas perguntas no mesmo balão.' })}
      ${field('Nome do campo', base + '.label', item.label, { full: false, max: 120 })}
      ${field('Identificador', base + '.id', item.id, { full: false, max: 64 })}
      ${selectField('Tipo de resposta', base + '.type', item.type, typeOptions)}
      ${isChoice ? field('Opções (uma por linha)', base + '.options', listToText(item.options), { type: 'textarea', rows: 3, help: 'A pergunta será enviada com estas opções.' }) : ''}
      ${field('Como interpretar a resposta', base + '.structure', item.structure || '', { type: 'textarea', rows: 2, max: 500, help: 'Ex.: aceite data aproximada; aceite “não sei” quando o campo não for essencial.' })}
      ${selectField('Condição para perguntar', base + '.askWhen.fieldId', item.askWhen?.fieldId || '', conditionOptions, 'Sem condição, a pergunta é sempre feita.')}
      ${field('Valor da condição', base + '.askWhen.value', item.askWhen?.value || '', { full: false, max: 200, help: 'A pergunta só será feita quando outro campo tiver exatamente este valor.' })}
      <div class="field full">
        <div class="switch-row plain-top">
          <div class="switch-copy"><strong>Campo necessário</strong><small>Sem esta resposta a triagem não termina normalmente.</small></div>
          <label class="switch"><input type="checkbox" data-path="${base}.required" ${item.required ? 'checked' : ''}><span></span></label>
        </div>
        <div class="switch-row plain-bottom">
          <div class="switch-copy"><strong>Usar a resposta para renomear o contato</strong><small>Um campo por área, geralmente o nome.</small></div>
          <label class="switch"><input type="checkbox" data-path="${base}.contactName" ${item.contactName ? 'checked' : ''}><span></span></label>
        </div>
      </div>
    </div>
  </div>`;
}

/* --------------------------------------------------------------- events */

const TRIGGERS = [
  ['keyword', 'Palavra-chave na mensagem'],
  ['first_message', 'Primeira mensagem do contato'],
  ['audio', 'Quando chega um áudio'],
  ['urgent', 'Quando a urgência é detectada'],
  ['human_requested', 'Quando o contato pede humano'],
  ['completed', 'Ao concluir a triagem'],
];

const ACTIONS = [
  ['send_message', 'Enviar uma mensagem'],
  ['notify_human', 'Avisar a equipe'],
  ['pause', 'Pausar a automação'],
];

function renderEvents() {
  const config = state.config;
  config.conditionalEvents = config.conditionalEvents || [];

  content.innerHTML =
    heading('Eventos e condições', 'O que o bot faz quando algo específico acontece.', 'Eventos são reações pontuais: uma palavra, um áudio, uma urgência, o fim da triagem. As palavras abaixo também definem quando a automação deve parar e chamar a equipe.') +
    `<section class="card">
      <div class="card-head">
        <div><h2>Eventos da conversa</h2><p class="card-desc">${config.conditionalEvents.length} de 20 eventos. O primeiro evento correspondente é executado e encerra o turno.</p></div>
        <button class="button small" data-action="add-event">Adicionar evento</button>
      </div>
      ${config.conditionalEvents.map((event, index) => eventCard(event, index)).join('') || '<div class="empty-state">Nenhum evento cadastrado. Sem eventos, o bot segue apenas o fluxo de perguntas.</div>'}
    </section>` +
    `<div class="grid two section-gap">
      <section class="card">
        <div class="card-head"><div><h2>Pausar e chamar a equipe</h2><p class="card-desc">A automação para, o contato recebe a mensagem de encaminhamento e a etiqueta muda para Atendimento.</p></div></div>
        <div class="field-grid">
          <div class="field full"><label for="f-handoffKeywords">Palavras de urgência</label>
            <textarea id="f-handoffKeywords" data-list-path="handoffKeywords" rows="6">${escapeHtml(listToText(config.handoffKeywords))}</textarea>
            <small class="help">Uma por linha. O contato recebe a mensagem de urgência e a equipe é avisada imediatamente. Ex.: prisão, medida protetiva, audiência hoje.</small>
          </div>
          <div class="field full"><label for="f-legalQuestionKeywords">Perguntas jurídicas a encaminhar</label>
            <textarea id="f-legalQuestionKeywords" data-list-path="legalQuestionKeywords" rows="6">${escapeHtml(listToText(config.legalQuestionKeywords))}</textarea>
            <small class="help">Perguntas que o bot nunca responde. Ex.: tenho direito, quanto vou receber, qual o prazo.</small>
          </div>
          <div class="field full"><label for="f-forbiddenTopics">Temas que sempre vão para a equipe</label>
            <textarea id="f-forbiddenTopics" data-list-path="forbiddenTopics" rows="4">${escapeHtml(listToText(config.forbiddenTopics))}</textarea>
            <small class="help">Assuntos que exigem análise humana, como “já tenho advogado” ou “processo em segredo de justiça”.</small>
          </div>
        </div>
      </section>
      <section class="card">
        <div class="card-head"><div><h2>Ordem de prioridade</h2><p class="card-desc">A primeira regra que combinar decide o que acontece naquele turno.</p></div></div>
        ${guide('Como o turno é decidido', [
          'O contato envia uma mensagem e ela é gravada na fila.',
          '<strong>Evento condicional</strong> — palavra-chave, áudio, primeira mensagem, urgência, pedido de humano ou conclusão.',
          '<strong>Comando humano</strong> — o texto é exatamente a palavra configurada.',
          '<strong>Palavras de urgência</strong> — envia a mensagem de urgência e chama a equipe.',
          '<strong>Pergunta jurídica</strong> ou tema proibido — envia o encaminhamento.',
          'Caso contrário, a IA tenta extrair a resposta do campo pendente.',
        ])}
        <div class="notice mt-14">Áudio com transcrição desativada sempre encaminha para a equipe, mesmo que a mensagem também contenha texto.</div>
      </section>
    </div>`;
}

function eventCard(event, index) {
  const base = `conditionalEvents.${index}`;
  const needsKeywords = event.trigger === 'keyword';
  return `<div class="event-card${event.enabled ? '' : ' disabled'}">
    <div class="event-head">
      <span class="question-index">${String(index + 1).padStart(2, '0')}</span>
      <span class="question-title">${escapeHtml(event.name || 'Novo evento')}</span>
      <span class="badge ${event.enabled ? 'green' : 'gray'}">${event.enabled ? 'Ativo' : 'Inativo'}</span>
      <button class="button small danger" data-action="remove-event" data-index="${index}">Remover</button>
    </div>
    <div class="field-grid">
      ${field('Nome do evento', base + '.name', event.name, { full: false, max: 120, help: 'Um nome curto que explique a intenção.' })}
      ${selectField('Quando acontece', base + '.trigger', event.trigger, TRIGGERS, 'Define o gatilho. Eventos de palavra-chave só disparam com as palavras abaixo.')}
      ${needsKeywords ? field('Palavras-chave (uma por linha)', base + '.keywords', listToText(event.keywords), { type: 'textarea', rows: 3, help: 'Basta conter uma delas em qualquer parte da mensagem.' }) : ''}
      ${selectField('O que fazer', base + '.action', event.action, ACTIONS, 'Enviar mensagem responde ao contato; avisar a equipe apenas notifica; pausar interrompe a automação.')}
      ${field('Mensagem enviada', base + '.message', event.message || '', { type: 'textarea', rows: 3, max: 1000, help: event.action === 'notify_human' ? 'Opcional: mensagem que o contato recebe antes do aviso à equipe.' : 'Obrigatória para eventos que enviam mensagem.' })}
      <div class="field full mt-tight">
        ${switchField('Evento ativo', base + '.enabled', event.enabled, 'Desative para manter o texto salvo sem usar no atendimento.')}
      </div>
    </div>
  </div>`;
}

/* ------------------------------------------------------------ knowledge */

function renderKnowledge() {
  const config = state.config;
  const samples = config.conversationStyleSamples || [];
  const materials = config.materials || [];
  const sampleChars = samples.reduce((total, sample) => total + sample.content.length, 0);
  const materialChars = materials.reduce((total, material) => total + material.content.length, 0);

  content.innerHTML =
    heading('Estilo e materiais', 'Ensine o seu jeito de atender — sem enviar dados de clientes.', 'Os exemplos de conversa ensinam tom, acolhimento e ordem das perguntas. Eles nunca são usados como prova na triagem e nunca aparecem para o contato.') +
    `<div class="grid two">
      <section class="card">
        <div class="card-head"><div><h2>Tom de voz</h2><p class="card-desc">Orientação interna para a equipe e para a extração.</p></div></div>
        <div class="field-grid">
          ${field('Como o escritório fala', 'writingStyle', config.writingStyle, { type: 'textarea', rows: 6, max: 4000, help: 'Descreva tom, tamanho das frases e o que evitar. Ex.: acolhedor e direto, sem juridiquês.' })}
          ${field('Regras de uso dos exemplos', 'conversationInstructions', config.conversationInstructions, { type: 'textarea', rows: 4, max: 4000, help: 'Explique o que a IA deve aprender — e o que não deve copiar.' })}
          ${field('Contexto do escritório', 'officeMemory', config.officeMemory, { type: 'textarea', rows: 5, max: 5000, help: 'Áreas atendidas, horário de retorno, cidades. Nada de dados de clientes.' })}
        </div>
      </section>
      <section class="card">
        <div class="card-head"><div><h2>Exemplos de conversa</h2><p class="card-desc">${samples.length}/10 exemplos · ${sampleChars}/30.000 caracteres</p></div></div>
        <label class="upload-zone" id="conversation-drop" for="conversation-files">
          <input id="conversation-files" type="file" multiple accept=".txt,.md,.markdown,text/plain" />
          <strong>Clique ou arraste um arquivo .txt da conversa</strong>
          <small>Exportação do WhatsApp serve. Até 12.000 caracteres por arquivo e 30.000 no conjunto.</small>
        </label>
        <div class="button-row mt-12">
          <button class="button primary" data-action="import-conversations">Importar exemplos</button>
        </div>
        <div id="conversation-import-result"></div>
        <div class="notice amber mt-12">Antes de importar, apague nomes, telefones, números de processo, valores e qualquer dado sensível. O arquivo é gravado no SQLite local.</div>
        <div class="rule"></div>
        ${samples.map((sample, index) => `<div class="sample">
          <div class="sample-head"><strong>${escapeHtml(sample.title)}</strong><span class="sample-meta">${sample.content.length} caracteres</span><button class="button small danger" data-action="remove-sample" data-index="${index}">Remover</button></div>
          <details><summary class="sample-meta summary-toggle">Ver conteúdo usado como referência</summary><pre>${escapeHtml(sample.content)}</pre></details>
        </div>`).join('') || '<div class="empty-state">Nenhum exemplo importado. Um único arquivo já ajuda a IA a reconhecer o seu jeito de falar.</div>'}
      </section>
    </div>` +
    `<section class="card section-gap">
      <div class="card-head">
        <div><h2>Materiais internos</h2><p class="card-desc">${materials.length}/20 · ${materialChars}/20.000 caracteres. Referência para a equipe; não é enviado ao modelo.</p></div>
        <button class="button small" data-action="add-material">Adicionar texto</button>
      </div>
      <div class="field-grid">
        <div class="field full">
          <label class="upload-zone" id="material-drop" for="material-files">
            <input id="material-files" type="file" multiple accept=".pdf,.txt,.md,.markdown,.csv,.json,.docx,.zip" />
            <strong>Clique ou arraste documentos de apoio</strong>
            <small>PDF, TXT, MD, CSV, JSON, DOCX ou ZIP com esses formatos. PDFs digitalizados exigem OCR.</small>
          </label>
        </div>
        <div class="field full"><div class="button-row"><button class="button primary" data-action="import-materials">Importar arquivos</button></div></div>
      </div>
      <div id="material-import-result"></div>
      <div class="rule"></div>
      ${materials.map((material, index) => `<div class="sample">
        <div class="sample-head"><strong>${escapeHtml(material.title)}</strong><span class="sample-meta">${material.content.length} caracteres</span><button class="button small danger" data-action="remove-material" data-index="${index}">Remover</button></div>
        <div class="field full mt-8"><label for="f-material-${index}">Título</label><input id="f-material-${index}" data-path="materials.${index}.title" value="${escapeHtml(material.title)}" maxlength="160" /></div>
        <div class="field full mt-8"><label for="f-material-content-${index}">Conteúdo</label><textarea id="f-material-content-${index}" data-path="materials.${index}.content" rows="4">${escapeHtml(material.content)}</textarea></div>
      </div>`).join('') || '<div class="empty-state">Nenhum material interno cadastrado.</div>'}
    </section>`;

  bindUploadZone('conversation-drop', 'conversation-files');
  bindUploadZone('material-drop', 'material-files');
}

function bindUploadZone(zoneId, inputId) {
  const zone = byId(zoneId);
  const input = byId(inputId);
  if (!zone || !input) return;
  ['dragenter', 'dragover'].forEach((type) => zone.addEventListener(type, (event) => { event.preventDefault(); zone.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach((type) => zone.addEventListener(type, (event) => { event.preventDefault(); zone.classList.remove('drag'); }));
  zone.addEventListener('drop', (event) => {
    const files = event.dataTransfer?.files;
    if (!files?.length) return;
    const transfer = new DataTransfer();
    for (const file of files) transfer.items.add(file);
    input.files = transfer.files;
    toast(`${files.length} arquivo(s) selecionado(s). Clique em importar.`);
  });
}

/* -------------------------------------------------------------- preview */

function renderPreview() {
  sim = { started: false, messages: [], fields: {}, profileId: null, pending: null, finished: false, notes: [] };
  const config = state.config;
  const profile = config.profiles.find((item) => item.id === config.defaultProfileId) || config.profiles[0];
  if (!profile) { content.innerHTML = heading('Testar conversa', 'Nenhuma área configurada', 'Crie ao menos uma área de atendimento para simular.'); return; }

  content.innerHTML =
    heading('Testar conversa', 'Veja a conversa antes de atender de verdade.', 'Esta simulação usa as mensagens, perguntas e eventos configurados. Não envia mensagens, não muda etiquetas e não chama Gemini nem Ollama.') +
    `<div class="chat-shell">
      <div class="chat-frame">
        <div class="chat-top">
          <span class="chat-avatar">${escapeHtml((config.officeName || 'E').slice(0, 1).toUpperCase())}</span>
          <div><strong>${escapeHtml(config.officeName)}</strong><br><small>${escapeHtml(config.assistantName)} · simulação</small></div>
        </div>
        <div id="sim-chat" class="chat-body" aria-live="polite">
          <div class="chat-empty" id="sim-empty">Clique em iniciar para ver como o contato recebe a abertura, a primeira pergunta e o ritmo dos balões.</div>
        </div>
        <form id="sim-form" class="chat-form hidden">
          <textarea id="sim-input" rows="2" maxlength="2000" placeholder="Escreva como se fosse o contato…"></textarea>
          <button class="button primary" type="submit">Enviar</button>
        </form>
      </div>
      <div>
        <section class="card">
          <div class="card-head"><div><h2>Controles do teste</h2><p class="card-desc">${escapeHtml(profile?.label || '')} · limite de ${config.maxCharsPerMessage} caracteres por balão</p></div></div>
          <div class="button-row">
            <button id="sim-start" class="button primary" data-action="sim-start">Iniciar simulação</button>
            <button class="button small" data-action="sim-audio">Simular áudio</button>
            <button class="button small" data-action="sim-failure">Simular falha da IA</button>
            <button class="button small" data-action="sim-human">Pedir humano</button>
            <button class="button quiet" data-action="sim-reset">Recomeçar</button>
          </div>
          <div class="rule"></div>
          <div class="guide"><strong class="title">O que este teste confere</strong><ol class="steps">
            <li><span>Ordem da abertura, dos balões e das perguntas.</span></li>
            <li><span>Palavras que disparam eventos, urgência e encaminhamento.</span></li>
            <li><span>Preenchimento dos campos, condições e conclusão da triagem.</span></li>
            <li><span>Se algum texto passa do limite de caracteres do balão.</span></li>
          </ol></div>
        </section>
        <section class="card">
          <div class="card-head"><div><h2>Observações do teste</h2><p class="card-desc">O que o sistema registraria neste turno.</p></div></div>
          <div id="sim-notes" class="timeline"><div class="empty-state">Nada executado ainda.</div></div>
        </section>
      </div>
    </div>`;

  byId('sim-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const input = byId('sim-input');
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    simulateMessage(text);
  });
  drawSim();
}

function splitBubbles(parts) {
  const config = state.config;
  const maxChars = Number(config.maxCharsPerMessage) || 500;
  const maxMessages = Number(config.maxMessagesPerTurn) || 3;
  const chunks = parts.map((part) => String(part || '').trim()).filter(Boolean).map((part) => splitPart(part, maxChars));
  const flat = chunks.flat();
  if (flat.length <= maxMessages) return flat;
  const finalChunks = chunks.at(-1) || [];
  if (finalChunks.length >= maxMessages) return finalChunks.slice(0, maxMessages);
  const prefix = chunks.slice(0, -1).flat();
  return [...prefix.slice(0, maxMessages - finalChunks.length), ...finalChunks];
}

function splitPart(text, maxChars) {
  const sentences = text.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [text];
  const result = [];
  let current = '';
  for (const raw of sentences) {
    const sentence = raw.trim();
    if (!sentence) continue;
    if (sentence.length > maxChars) {
      if (current) { result.push(current); current = ''; }
      let rest = sentence;
      while (rest.length > maxChars) {
        let cut = rest.lastIndexOf(' ', maxChars);
        if (cut < 1) cut = maxChars;
        result.push(rest.slice(0, cut).trim());
        rest = rest.slice(cut).trim();
      }
      if (rest) result.push(rest);
      continue;
    }
    const candidate = current ? `${current} ${sentence}` : sentence;
    if (candidate.length > maxChars) { result.push(current); current = sentence; }
    else current = candidate;
  }
  if (current) result.push(current);
  return result;
}

function normalizeText(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}
function includesAny(text, keywords) {
  const normalized = normalizeText(text);
  return (keywords || []).some((keyword) => normalizeText(keyword) && normalized.includes(normalizeText(keyword)));
}

function simSay(text) {
  for (const bubble of splitBubbles([text])) sim.messages.push({ from: 'bot', text: bubble });
}
function simNote(text) { sim.notes.push(text); }
function simBlocked() { sim.pending = null; sim.finished = true; }

function eventsFor(trigger) {
  return (state.config.conditionalEvents || []).filter((event) => event.enabled && event.trigger === trigger);
}
function runSimEvents(trigger) {
  let handled = false;
  for (const event of eventsFor(trigger)) {
    if (event.action === 'notify_human') simNote(`Equipe avisada: ${event.name}`);
    if (event.message.trim()) simSay(event.message);
    simNote(`Evento executado: ${event.name}`);
    if (event.action === 'pause') simBlocked();
    handled = true;
  }
  return handled;
}

function startSimulation() {
  const config = state.config;
  const profile = config.profiles.find((item) => item.id === config.defaultProfileId) || config.profiles[0];
  sim.started = true;
  sim.profileId = profile.id;
  sim.finished = false;
  sim.messages = [];
  sim.notes = [];
  sim.fields = {};

  if (config.aiProvider === 'gemini' || config.audioTranscriptionProvider === 'gemini') {
    simSay(config.externalProviderNotice);
    simNote('Aviso de processamento externo enviado antes de qualquer conteúdo ir ao Gemini.');
  }
  simSay([config.greeting, config.assistantNotice, config.privacyNotice].filter(Boolean).join(' '));
  const first = profile.fields.find((item) => item.id === config.areaFieldId) || profile.fields.find((item) => item.required) || profile.fields[0];
  sim.pending = first?.id || null;
  simSay(first?.id === config.areaFieldId ? config.areaQuestion : first?.question || '');
  simNote(`Área inicial: ${profile.label}. A primeira mensagem do contato fica fora da IA.`);
  drawSim();
}

function simulateMessage(text) {
  const config = state.config;
  if (!sim?.started || sim.finished) return;
  sim.messages.push({ from: 'user', text });
  const profile = config.profiles.find((item) => item.id === sim.profileId) || config.profiles[0];

  const matchedEvent = (config.conditionalEvents || []).find((event) => event.enabled && event.trigger === 'keyword'
    && includesAny(text, event.keywords));
  if (matchedEvent) {
    if (matchedEvent.action === 'notify_human') simNote(`Equipe avisada: ${matchedEvent.name}`);
    if (matchedEvent.message.trim()) simSay(matchedEvent.message);
    simNote(`Evento executado: ${matchedEvent.name}`);
    if (matchedEvent.action === 'pause') simBlocked();
    drawSim();
    return;
  }

  const isHuman = normalizeText(text) === normalizeText(config.humanCommand);
  if (isHuman) {
    runSimEvents('human_requested');
    simSay(config.handoffMessage);
    simNote('Comando de atendimento humano reconhecido.');
    simBlocked();
    drawSim();
    return;
  }
  if (includesAny(text, config.handoffKeywords)) {
    simSay(config.urgencyMessage);
    runSimEvents('urgent');
    simNote('Palavra de urgência: triagem interrompida e etiqueta alterada para Atendimento.');
    simBlocked();
    drawSim();
    return;
  }
  if (includesAny(text, config.legalQuestionKeywords) || includesAny(text, config.forbiddenTopics)) {
    simSay(config.handoffMessage);
    simNote('Pergunta jurídica ou tema reservado: encaminhado sem resposta automática.');
    simBlocked();
    drawSim();
    return;
  }

  if (sim.pending) sim.fields[sim.pending] = text;
  const shouldAsk = (item) => !item.askWhen || normalizeText(sim.fields[item.askWhen.fieldId] || '') === normalizeText(item.askWhen.value);
  const next = profile.fields.find((item) => !sim.fields[item.id] && shouldAsk(item));
  if (next) {
    sim.pending = next.id;
    simSay([config.acknowledgementMessage, next.question].filter(Boolean).join(' '));
    simNote(`Campo capturado. Próxima pergunta: ${next.label}.`);
  } else {
    sim.pending = null;
    simSay(config.completionMessage);
    runSimEvents('completed');
    simNote('Triagem concluída: mensagem final enviada e etiqueta alterada para Atendimento.');
    sim.finished = true;
  }
  drawSim();
}

function drawSim() {
  const chat = byId('sim-chat');
  if (!chat) return;
  if (!sim?.started) {
    chat.innerHTML = '<div class="chat-empty" id="sim-empty">Clique em iniciar para ver como o contato recebe a abertura, a primeira pergunta e o ritmo dos balões.</div>';
  } else {
    chat.innerHTML = sim.messages.map((message) => `<div class="bubble ${message.from === 'user' ? 'outgoing' : ''}">${escapeHtml(message.text)}</div>`).join('')
      + (sim.finished ? '<div class="typing">Atendimento automático encerrado. A equipe assume a partir daqui.</div>' : '');
  }
  const form = byId('sim-form');
  if (form) form.classList.toggle('hidden', !sim?.started || sim.finished);
  const notes = byId('sim-notes');
  if (notes) {
    notes.innerHTML = sim.notes.length
      ? sim.notes.map((note) => `<article class="timeline-item"><span class="timeline-dot"></span><div class="timeline-copy"><span>${escapeHtml(note)}</span></div></article>`).join('')
      : '<div class="empty-state">Nada executado ainda.</div>';
  }
  chat.scrollTop = chat.scrollHeight;
}

/* -------------------------------------------------------------- whatsapp */

function renderWhatsApp() {
  const config = state.config;
  content.innerHTML =
    heading('Conexão WhatsApp', 'A sessão que o agente usa para atender.', 'O agente responde pelo WhatsApp Web. Use um número de teste e confirme as listas antes de ativar o atendimento real.') +
    `<div class="grid two">
      <section class="card">
        <div class="card-head"><div><h2>Estado da sessão</h2><p class="card-desc" id="whatsapp-status-detail">Consultando o provedor…</p></div><span id="whatsapp-status-badge" class="badge gray">Consultando…</span></div>
        <div class="button-row"><button class="button small" data-action="refresh-whatsapp">Atualizar estado</button><button id="whatsapp-restart" class="button small danger hidden" data-action="restart-whatsapp">Reiniciar sessão</button></div>
        <div id="whatsapp-provider-help" class="notice mt-12">A leitura do status pode levar alguns segundos.</div>
      </section>
      <section class="card">
        <div class="card-head"><div><h2>Provedor</h2><p class="card-desc">Este fluxo depende das etiquetas nativas do WhatsApp.</p></div></div>
        ${selectField('Integração', 'whatsappProvider', config.whatsappProvider, [['openwa', 'OpenWA (gateway)'], ['waha', 'WAHA'], ['baileys', 'Baileys']], 'A Meta Cloud API não sincroniza as listas usadas para autorizar respostas.')}
        <div class="notice amber mt-12">OpenWA, WAHA e Baileys usam o protocolo do WhatsApp Web e não são a API oficial. Existe risco de desconexão ou restrição da conta.</div>
        <div class="notice mt-12">Com OpenWA, a sessão, o envio e o recebimento ficam no gateway; esta aplicação continua decidindo quem pode receber resposta por meio das etiquetas. O OpenWA precisa estar em execução e a chave fica somente no servidor.</div>
      </section>
    </div>` +
    `<section class="card section-gap hidden" id="whatsapp-qr-card">
      <div class="card-head"><div><h2>Parear este número</h2><p class="card-desc">No WhatsApp do número de teste: <b>Aparelhos conectados → Conectar aparelho</b>. Escaneie o código abaixo.</p></div></div>
      <div class="qr-wrap"><img id="whatsapp-qr" alt="QR de pareamento da sessão WhatsApp" /></div>
    </section>`;

  void refreshWhatsAppStatus();
  state.poller = setInterval(() => void refreshWhatsAppStatus(), 5000);
}

async function refreshWhatsAppStatus() {
  const badge = byId('whatsapp-status-badge');
  if (!badge) return;
  try {
    const status = await api('/api/whatsapp/status');
    const code = String(status.state || 'UNKNOWN').toUpperCase();
    const provider = { waha: 'WAHA', openwa: 'OpenWA', meta: 'Meta Cloud API', baileys: 'Baileys' }[status.provider] || status.provider;
    const names = {
      WORKING: 'Conectado', SYNCING_LABELS: 'Sincronizando listas', CONFIGURED: 'Configurado',
      SCAN_QR_CODE: 'Aguardando QR', STARTING: 'Iniciando', STOPPED: 'Parado',
      FAILED: 'Falha na sessão', DISCONNECTED: 'Desconectado', INITIALIZING: 'Inicializando',
    };
    badge.textContent = names[code] || code;
    badge.className = 'badge ' + (status.connected && status.labelsReady !== false ? 'green' : code === 'FAILED' || code === 'DISCONNECTED' ? 'red' : 'amber');
    byId('whatsapp-status-detail').textContent = [provider, status.session ? `sessão ${status.session}` : '', status.engine ? `mecanismo ${status.engine}` : '', status.account ? `conta ${status.account}` : ''].filter(Boolean).join(' · ');

    const help = byId('whatsapp-provider-help');
    const qrCard = byId('whatsapp-qr-card');
    const restart = byId('whatsapp-restart');
    if ((status.provider === 'waha' || status.provider === 'openwa') && code === 'SCAN_QR_CODE') {
      help.textContent = 'Abra o WhatsApp no celular, escolha Aparelhos conectados e leia o QR. Mantenha o painel aberto até o status mudar para Conectado.';
      qrCard.classList.remove('hidden');
      byId('whatsapp-qr').src = `/api/whatsapp/qr?t=${Date.now()}`;
    } else {
      qrCard.classList.add('hidden');
      byId('whatsapp-qr').removeAttribute('src');
      if (status.provider === 'baileys' && code === 'SYNCING_LABELS') help.textContent = 'A sessão conectou, mas as listas nativas ainda não foram confirmadas. O bot não responde até essa leitura terminar; falhas são repetidas automaticamente.';
      else if (status.provider === 'baileys' && status.connected) help.textContent = 'Baileys conectado e listas sincronizadas. O QR de primeiro pareamento aparece no terminal que iniciou a aplicação.';
      else if (status.provider === 'baileys') help.textContent = 'A sessão Baileys não está ativa. Verifique o terminal que iniciou a aplicação; se o dispositivo foi desconectado, é preciso parear novamente.';
      else if (code === 'WORKING') help.textContent = 'Sessão ativa. O agente pode receber mensagens, transcrever áudio e aplicar etiquetas.';
      else if (status.provider === 'openwa') help.textContent = 'O OpenWA não está pronto. Confira o container/serviço do gateway, a sessão e as credenciais no ambiente do servidor; o painel atualiza sozinho.';
      else if (code === 'FAILED' || code === 'STOPPED') help.textContent = 'A sessão não está ativa. Consulte os logs do WAHA e reinicie se necessário.';
      else help.textContent = 'A sessão ainda está iniciando ou reconectando. O painel atualiza sozinho.';
    }
    restart.classList.toggle('hidden', !['waha', 'openwa'].includes(status.provider) || !['FAILED', 'STOPPED', 'DISCONNECTED'].includes(code));
  } catch (error) {
    badge.textContent = 'Indisponível';
    badge.className = 'badge red';
    byId('whatsapp-status-detail').textContent = error.message;
    byId('whatsapp-provider-help').textContent = 'Não foi possível consultar o provedor. Verifique a conexão e as credenciais no ambiente do servidor.';
    byId('whatsapp-qr-card').classList.add('hidden');
    byId('whatsapp-restart').classList.add('hidden');
  }
}

/* ----------------------------------------------------------------- lists */

function renderLists() {
  const meta = state.config.whatsappProvider === 'meta';
  content.innerHTML =
    heading('Regras das listas', 'Quem pode receber resposta automática.', 'As etiquetas do próprio WhatsApp são a única autorização. O painel não importa histórico nem libera contatos manualmente.') +
    `<div class="grid two">
      <section class="card">
        <div class="card-head"><div><h2>Fluxo automático das etiquetas</h2><p class="card-desc">Conferido antes de cada envio.</p></div></div>
        <ol class="steps">
          <li><span>Mensagem recebida de contato fora de <span class="code">Clientes</span> inicia a triagem.</span></li>
          <li><span>O agente aplica <span class="code">Novo Lead</span> e <span class="code">Bot - atendimento</span> juntas.</span></li>
          <li><span>Com <span class="code">Clientes</span> aplicada, o bot não responde mesmo com a etiqueta do bot.</span></li>
          <li><span>Remover <span class="code">Bot - atendimento</span> interrompe a automação imediatamente.</span></li>
          <li><span>Ao concluir ou encaminhar, a etiqueta muda para <span class="code">Atendimento</span> e a equipe assume.</span></li>
        </ol>
        <div class="notice ${meta ? 'amber' : 'green'} mt-14">${meta ? 'A Meta Cloud API não sincroniza estas listas. Selecione OpenWA, WAHA ou Baileys.' : 'Listas nativas ativas no provedor selecionado.'}</div>
      </section>
      <section class="card">
        <div class="card-head"><div><h2>O que cada lista faz</h2><p class="card-desc">Nomes precisam ser exatamente estes.</p></div></div>
        <div class="timeline">
          <article class="timeline-item"><span class="timeline-dot good"></span><div class="timeline-copy"><strong>Bot - atendimento</strong><span>Autoriza a automação. É a chave do bot.</span></div></article>
          <article class="timeline-item"><span class="timeline-dot"></span><div class="timeline-copy"><strong>Novo Lead</strong><span>Marca o contato que entrou pela triagem.</span></div></article>
          <article class="timeline-item"><span class="timeline-dot bad"></span><div class="timeline-copy"><strong>Clientes</strong><span>Bloqueia qualquer resposta automática.</span></div></article>
          <article class="timeline-item"><span class="timeline-dot"></span><div class="timeline-copy"><strong>Atendimento</strong><span>Indica que a equipe assumiu. Não autoriza respostas.</span></div></article>
        </div>
        <div class="notice mt-14">Se a leitura das listas falhar, as mensagens ficam pendentes e nada é enviado até a confirmação.</div>
      </section>
    </div>`;
}

/* ----------------------------------------------------------- diagnostics */

async function renderDiagnostics() {
  content.innerHTML =
    heading('Fila e diagnósticos', 'O que aconteceu com cada mensagem.', 'Acompanhe recebimento, fila, envio, pausas e falhas. Nenhum texto de conversa é registrado aqui.') +
    `<section class="card">
      <div class="card-head"><div><h2>Eventos recentes</h2><p class="card-desc">Mensagens pendentes mostram o motivo; falhas mostram o erro para orientar a correção.</p></div><button class="button small" data-action="refresh-diagnostics">Atualizar</button></div>
      <div id="diagnostics-list" class="timeline"><div class="empty-state">Carregando eventos…</div></div>
    </section>`;
  try {
    const events = await api('/api/diagnostics');
    const list = byId('diagnostics-list');
    if (!list) return;
    list.innerHTML = events.length
      ? events.map((event) => `<article class="timeline-item"><span class="timeline-dot ${event.event.includes('falha') ? 'bad' : event.event === 'respondida' ? 'good' : ''}"></span><div class="timeline-copy"><strong>${escapeHtml(event.event.replaceAll('-', ' '))}</strong><span>${escapeHtml(event.detail || '—')}</span><small>${escapeHtml(event.jid)} · ${new Date(event.createdAt).toLocaleString('pt-BR')}</small></div></article>`).join('')
      : '<div class="empty-state">Nenhum evento registrado ainda.</div>';
  } catch (error) {
    const list = byId('diagnostics-list');
    if (list) list.innerHTML = `<div class="notice amber">Não foi possível carregar os eventos: ${escapeHtml(error.message)}</div>`;
  }
}

/* ------------------------------------------------------------- actions */

function handleAction(name, element) {
  const index = Number(element?.dataset?.index);
  const config = state.config;
  if (name === 'greeting-preset') {
    config.greeting = GREETING_PRESETS[index].text;
    const textarea = byId('f-greeting');
    if (textarea) { textarea.value = config.greeting; textarea.dispatchEvent(new Event('input')); }
    markDirty();
    refreshOpeningPreview();
    toast(`Cumprimento “${GREETING_PRESETS[index].label}” aplicado.`);
    return;
  }
  if (name === 'apply-template') { applyStarterTemplate(); return; }
  if (name === 'add-profile') {
    const id = `area-${Date.now().toString(36)}`;
    config.profiles.push({
      id,
      label: 'Nova área',
      triggers: [],
      fields: [{ id: config.areaFieldId, label: 'Área ou assunto', question: 'Em poucas palavras, qual é o assunto?', type: 'open_text', options: [], structure: '', required: true }],
    });
    state.profileIndex = config.profiles.length - 1;
    markDirty(); renderFlow(); bindContent(); return;
  }
  if (name === 'remove-profile') {
    if (config.profiles.length < 2) { toast('Mantenha ao menos uma área de atendimento.', true); return; }
    config.profiles.splice(state.profileIndex, 1);
    state.profileIndex = 0;
    if (!config.profiles.some((item) => item.id === config.defaultProfileId)) config.defaultProfileId = config.profiles[0].id;
    markDirty(); renderFlow(); bindContent(); return;
  }
  if (name === 'add-field') {
    config.profiles[state.profileIndex].fields.push({ id: `campo-${Date.now().toString(36)}`, label: 'Nova pergunta', question: '', type: 'open_text', options: [], structure: '', required: true });
    markDirty(); renderFlow(); bindContent(); return;
  }
  if (name === 'remove-field') {
    const profile = config.profiles[state.profileIndex];
    profile.fields.splice(index, 1);
    if (!profile.fields.length) profile.fields.push({ id: `campo-${Date.now().toString(36)}`, label: 'Pergunta inicial', question: 'Qual é o assunto?', type: 'open_text', options: [], structure: '', required: true });
    markDirty(); renderFlow(); bindContent(); return;
  }
  if (name === 'up-field' && index > 0) {
    const fields = config.profiles[state.profileIndex].fields;
    [fields[index - 1], fields[index]] = [fields[index], fields[index - 1]];
    markDirty(); renderFlow(); bindContent(); return;
  }
  if (name === 'down-field') {
    const fields = config.profiles[state.profileIndex].fields;
    if (index < fields.length - 1) {
      [fields[index + 1], fields[index]] = [fields[index], fields[index + 1]];
      markDirty(); renderFlow(); bindContent();
    }
    return;
  }
  if (name === 'add-event') {
    config.conditionalEvents = config.conditionalEvents || [];
    if (config.conditionalEvents.length >= 20) { toast('Limite de 20 eventos.', true); return; }
    config.conditionalEvents.push({ id: `evento-${Date.now().toString(36)}`, name: 'Novo evento', trigger: 'keyword', keywords: [], action: 'send_message', message: '', enabled: true });
    markDirty(); renderEvents(); bindContent(); return;
  }
  if (name === 'remove-event') { config.conditionalEvents.splice(index, 1); markDirty(); renderEvents(); bindContent(); return; }
  if (name === 'remove-sample') { config.conversationStyleSamples.splice(index, 1); markDirty(); render(); return; }
  if (name === 'add-material') {
    config.materials = config.materials || [];
    if (config.materials.length >= 20) { toast('Limite de 20 materiais.', true); return; }
    config.materials.push({ title: 'Novo material', content: 'Conteúdo de apoio.' });
    markDirty(); renderKnowledge(); bindContent(); return;
  }
  if (name === 'remove-material') { config.materials.splice(index, 1); markDirty(); renderKnowledge(); bindContent(); return; }
  if (name === 'import-conversations') { void importConversations(); return; }
  if (name === 'import-materials') { void importMaterials(); return; }
  if (name === 'refresh-whatsapp') { void refreshWhatsAppStatus(); return; }
  if (name === 'restart-whatsapp') { void restartWhatsApp(); return; }
  if (name === 'refresh-diagnostics') { void renderDiagnostics(); return; }
  if (name === 'sim-start') { startSimulation(); return; }
  if (name === 'sim-reset') { renderPreview(); bindContent(); return; }
  if (name === 'sim-human') { if (sim?.started) simulateMessage(state.config.humanCommand); return; }
  if (name === 'sim-audio') {
    if (!sim?.started) { toast('Inicie a simulação primeiro.', true); return; }
    sim.messages.push({ from: 'user', text: '[áudio recebido]' });
    if (state.config.audioTranscriptionProvider === 'disabled') {
      simSay(state.config.audioRetryMessage);
      simNote('Áudio com transcrição desativada: a equipe assume o atendimento.');
      simBlocked();
    } else if (!runSimEvents('audio')) {
      simSay(state.config.audioRetryMessage);
      simNote('Transcrição indisponível neste teste: mensagem de contingência enviada.');
    }
    drawSim(); return;
  }
  if (name === 'sim-failure') {
    if (!sim?.started) { toast('Inicie a simulação primeiro.', true); return; }
    simSay(state.config.aiFallbackMessage);
    simNote('Falha simulada da IA: triagem encaminhada sem resposta livre.');
    simBlocked();
    drawSim(); return;
  }
}

async function importConversations() {
  const input = byId('conversation-files');
  if (!input?.files?.length) { toast('Selecione um arquivo .txt ou .md primeiro.', true); return; }
  if (state.dirty) { toast('Salve as alterações atuais antes de importar.', true); return; }
  const form = new FormData();
  for (const file of input.files) form.append('files', file, file.name);
  const button = content.querySelector('[data-action="import-conversations"]');
  if (button) { button.disabled = true; button.textContent = 'Lendo exemplos…'; }
  try {
    const result = await api('/api/conversations/import', { method: 'POST', body: form });
    state.config = await api('/api/config');
    renderKnowledge(); bindContent();
    const report = byId('conversation-import-result');
    if (report) report.innerHTML = `<div class="${result.results.some((item) => !item.ok) ? 'notice amber' : 'notice green'} import-report"><strong>${result.imported} exemplo(s) importado(s)</strong><ul>${result.results.map((item) => `<li><b>${escapeHtml(item.file)}</b>: ${escapeHtml(item.detail)}</li>`).join('')}</ul></div>`;
    toast(`${result.imported} exemplo(s) de conversa importado(s).`, result.results.some((item) => !item.ok));
  } catch (error) { toast(error.message, true); }
}

async function importMaterials() {
  const input = byId('material-files');
  if (!input?.files?.length) { toast('Selecione um ou mais arquivos primeiro.', true); return; }
  if (state.dirty) { toast('Salve as alterações atuais antes de importar.', true); return; }
  const form = new FormData();
  for (const file of input.files) form.append('files', file, file.name);
  const button = content.querySelector('[data-action="import-materials"]');
  if (button) { button.disabled = true; button.textContent = 'Lendo arquivos…'; }
  try {
    const result = await api('/api/materials/import', { method: 'POST', body: form });
    state.config = await api('/api/config');
    renderKnowledge(); bindContent();
    const report = byId('material-import-result');
    if (report) report.innerHTML = `<div class="${result.results.some((item) => !item.ok) ? 'notice amber' : 'notice green'} import-report"><strong>${result.imported} arquivo(s) processado(s)</strong><ul>${result.results.map((item) => `<li><b>${escapeHtml(item.file)}</b>: ${escapeHtml(item.detail)}</li>`).join('')}</ul></div>`;
    toast(`${result.imported} arquivo(s) importado(s).`, result.results.some((item) => !item.ok));
  } catch (error) { toast(error.message, true); }
}

async function restartWhatsApp() {
  const button = byId('whatsapp-restart');
  if (button) button.disabled = true;
  try {
    await api('/api/whatsapp/restart', { method: 'POST', body: '{}' });
    toast('Solicitação de reinício enviada.');
    await refreshWhatsAppStatus();
  } catch (error) { toast(error.message, true); }
  finally { if (button) button.disabled = false; }
}

/* ------------------------------------------------------- starter template */

const AREA_SEEDS = [
  {
    id: 'trabalhista', label: 'Direito do Trabalho',
    triggers: ['trabalhista', 'trabalho', 'demissão', 'demitido', 'demitida', 'clt', 'horas extras', 'fgts', 'salário atrasado', 'acidente de trabalho', 'assédio no trabalho'],
    question: 'Qual é a situação com a empresa? Por exemplo, demissão, salário atrasado, horas extras ou acidente.',
    extra: [
      { id: 'vinculo', label: 'Vínculo atual', question: 'Você ainda trabalha nessa empresa ou já foi desligado(a)?', type: 'single_choice', options: ['Ainda trabalho lá', 'Já fui desligado(a)', 'Nunca fui registrado(a)', 'Presto serviço como autônomo(a)'], required: true },
      { id: 'quando', label: 'Quando aconteceu', question: 'Quando isso aconteceu, aproximadamente? Se não souber a data exata, diga o mês e o ano.', type: 'open_text', options: [], required: true },
    ],
  },
  {
    id: 'previdenciario', label: 'Direito Previdenciário (INSS)',
    triggers: ['inss', 'aposentadoria', 'aposentar', 'auxílio-doença', 'auxílio doença', 'benefício', 'bpc', 'perícia', 'pensão por morte'],
    question: 'Qual é o assunto com o INSS? Por exemplo, aposentadoria, auxílio por doença, BPC ou pensão.',
    extra: [
      { id: 'situacao', label: 'Situação do pedido', question: 'O pedido já foi feito no INSS? O que aconteceu depois?', type: 'single_choice', options: ['Ainda não pedi', 'Pedi e está em análise', 'Pedi e foi negado', 'Já recebo o benefício', 'Não sei informar'], required: true },
      { id: 'tempo', label: 'Tempo de contribuição', question: 'Você sabe há quanto tempo contribui para o INSS, mesmo com trabalho informal?', type: 'open_text', options: [], required: false },
    ],
  },
  {
    id: 'familia', label: 'Direito de Família',
    triggers: ['família', 'familia', 'divórcio', 'divorcio', 'pensão', 'guarda', 'inventário', 'inventario', 'união estável', 'uniao estavel', 'alimentos'],
    question: 'Qual é a situação? Por exemplo, divórcio, pensão, guarda dos filhos ou inventário.',
    extra: [
      { id: 'filhos', label: 'Filhos menores', question: 'Existem filhos menores de idade envolvidos?', type: 'yes_no', options: [], required: true },
      { id: 'acordo', label: 'Tentativa de acordo', question: 'Vocês já tentaram conversar ou fazer um acordo sobre isso?', type: 'single_choice', options: ['Sim, e não deu certo', 'Sim, e está quase certo', 'Ainda não tentamos', 'Não tenho contato com a outra pessoa'], required: true },
    ],
  },
  {
    id: 'consumidor', label: 'Direito do Consumidor',
    triggers: ['consumidor', 'produto', 'compra', 'cobrança', 'cobranca', 'plano de saúde', 'banco', 'cartão', 'loja', 'internet'],
    question: 'O que aconteceu com a compra, o serviço ou a cobrança?',
    extra: [
      { id: 'empresa', label: 'Empresa', question: 'Qual é a empresa ou o banco envolvido?', type: 'open_text', options: [], required: true },
      { id: 'reclamacao', label: 'Reclamação formal', question: 'Você já registrou reclamação no site da empresa, no Procon ou em outro canal?', type: 'single_choice', options: ['Sim, no Procon', 'Sim, só no site ou telefone da empresa', 'Não registrei ainda', 'Não sei como registrar'], required: true },
    ],
  },
  {
    id: 'civel', label: 'Direito Cível e Imóveis',
    triggers: ['cível', 'civel', 'contrato', 'imóvel', 'imovel', 'aluguel', 'locação', 'locacao', 'indenização', 'indenizacao', 'dívida', 'divida', 'condomínio', 'despejo'],
    question: 'Qual é o assunto? Por exemplo, contrato, aluguel, dívida, imóvel ou indenização.',
    extra: [
      { id: 'documento', label: 'Existe documento', question: 'Existe contrato, comprovante ou algum documento sobre esse assunto?', type: 'single_choice', options: ['Sim, tenho em mãos', 'Sim, mas não tenho acesso agora', 'Não existe documento', 'Não sei informar'], required: true },
    ],
  },
  {
    id: 'criminal', label: 'Direito Criminal e Urgências',
    triggers: ['criminal', 'prisão', 'prisao', 'flagrante', 'delegacia', 'boletim de ocorrência', 'medida protetiva', 'ameaça', 'ameaca', 'inquérito', 'audiência de custódia'],
    question: 'O que aconteceu? Se alguém foi preso ou há risco agora, escreva isso na primeira frase.',
    extra: [
      { id: 'risco', label: 'Risco imediato', question: 'Existe risco imediato para alguém agora?', type: 'yes_no', options: [], required: true },
    ],
  },
];

function starterTemplate() {
  const local = { id: 'local', label: 'Cidade e estado', question: 'Em qual cidade e estado aconteceu ou está sendo tratado esse assunto?', type: 'open_text', options: [], structure: 'Aceite cidade e estado, mesmo abreviados.', required: true };
  const name = { id: 'nome', label: 'Nome', question: 'Como você gostaria de ser chamado(a)?', type: 'open_text', options: [], structure: 'Aceite apenas o primeiro nome se a pessoa preferir.', required: true, contactName: true };

  return {
    officeName: state.config.officeName || 'Escritório de Advocacia',
    assistantName: 'Assistente virtual do escritório',
    writingStyle: 'Escreva em português do Brasil, com tom humano, acolhedor e profissional. Use frases curtas, uma ideia por frase, e trate a pessoa por "você". Comece acolhendo o que a pessoa sentiu ("Entendi", "Sinto muito por isso") e só depois faça a próxima pergunta. Nunca prometa resultado, nunca diga que o caso será aceito e nunca dê prazo de resposta que o escritório não confirmou.',
    officeMemory: 'Escritório generalista com atuação em Direito Trabalhista, Previdenciário, de Família, do Consumidor, Cível e Criminal. A triagem inicial é feita por assistente virtual; um advogado da equipe avalia o caso depois. Horário de atendimento humano: segunda a sexta, das 9h às 18h.',
    forbiddenTopics: ['já tenho advogado', 'outro advogado já analisou'],
    conversationInstructions: 'Use os exemplos apenas para aprender o tom, a forma de acolher, o tamanho das mensagens e a ordem das perguntas. Nunca copie nomes, telefones, processos, valores ou fatos de clientes.',
    greeting: GREETING_PRESETS[0].text,
    assistantNotice: 'Sou um assistente virtual e faço apenas a triagem inicial. Não sou advogado e esta conversa não é uma consulta jurídica.',
    privacyNotice: 'Compartilhe somente o necessário para esta triagem. Não envie documentos, fotos ou dados sensíveis nesta primeira conversa.',
    externalProviderNotice: 'Para continuar, o que você escrever a partir deste aviso poderá ser processado pelo Google Gemini apenas para organizar a triagem. Se preferir, escreva HUMANO ou não continue.',
    areaQuestion: 'Para começar: qual é o assunto? Por exemplo, trabalho, aposentadoria, família, compra ou dívida, imóvel ou outra situação.',
    handoffMessage: 'Vou encaminhar seu atendimento para a equipe do escritório. Um profissional vai analisar o seu relato e dar continuidade assim que possível, dentro do horário de atendimento.',
    audioRetryMessage: 'Não consegui entender esse áudio com segurança. Pode reenviar ou resumir por escrito?',
    clarificationMessage: 'Não consegui identificar essa informação com segurança. Pode responder de outra forma, com outras palavras?',
    aiFallbackMessage: 'Não consegui continuar a triagem com segurança. Vou encaminhar seu atendimento para a equipe do escritório.',
    acknowledgementMessage: 'Obrigado, já registrei.',
    completionMessage: 'Pronto, registrei tudo o que precisava. Seu relato será encaminhado para a equipe do escritório, que dará continuidade dentro do horário de atendimento.',
    urgencyMessage: 'Entendi que pode haver urgência. Vou interromper as perguntas e encaminhar seu relato imediatamente para a equipe.',
    handoffKeywords: ['audiência hoje', 'audiência amanhã', 'prazo hoje', 'prazo amanhã', 'preso', 'prisão', 'flagrante', 'medida protetiva', 'risco imediato', 'ameaça', 'fui agredido', 'fui agredida', 'despejo hoje'],
    legalQuestionKeywords: ['tenho direito', 'posso processar', 'qual o prazo', 'o que devo fazer', 'quanto vou receber', 'posso ser demitido', 'quais são meus direitos', 'vou ganhar', 'quanto tempo demora', 'o que diz a lei'],
    conditionalEvents: [
      { id: 'evento-urgencia', name: 'Orientar em situação de urgência', trigger: 'urgent', keywords: [], action: 'send_message', message: 'Se houver risco imediato à sua segurança, ligue 190. Se houver risco à sua saúde, procure o serviço de emergência mais próximo. Sua mensagem já está registrada para a equipe.', enabled: true },
      { id: 'evento-documentos', name: 'Pedido de documentos', trigger: 'keyword', keywords: ['documento', 'documentos', 'contracheque', 'carteira de trabalho'], action: 'send_message', message: 'Nesta primeira etapa não é necessário enviar documentos, fotos ou números de processo. A equipe vai solicitar o que for preciso depois da análise inicial.', enabled: true },
      { id: 'evento-conclusao', name: 'Avisar a equipe ao concluir', trigger: 'completed', keywords: [], action: 'notify_human', message: '', enabled: true },
    ],
    defaultProfileId: 'triagem-inicial',
    areaFieldId: 'assunto',
    profiles: [
      {
        id: 'triagem-inicial',
        label: 'Triagem inicial (geral)',
        triggers: [],
        fields: [
          { id: 'assunto', label: 'Assunto', question: 'Em poucas palavras, o que aconteceu ou o que você precisa resolver?', type: 'open_text', options: [], structure: 'Aceite um relato livre. Não interprete juridicamente; apenas registre o assunto.', required: true },
          { ...name },
          { ...local },
          { id: 'prazo', label: 'Prazo ou audiência', question: 'Existe alguma data, prazo ou audiência próxima que a equipe precise saber?', type: 'yes_no', options: [], structure: 'Se responder sim, registre a data aproximada informada.', required: true },
          { id: 'processo', label: 'Processo ou advogado', question: 'Já existe processo ou outro advogado acompanhando o caso?', type: 'yes_no', options: [], structure: '', required: false },
        ],
      },
      ...AREA_SEEDS.map((seed) => ({
        id: seed.id,
        label: seed.label,
        triggers: seed.triggers,
        fields: [
          { id: 'assunto', label: 'Assunto', question: seed.question, type: 'open_text', options: [], structure: '', required: true },
          { ...name },
          ...seed.extra.map((item) => ({ ...item, structure: '' })),
          { ...local },
        ],
      })),
    ],
  };
}

function applyStarterTemplate() {
  if (!confirm('Aplicar o modelo de escritório? Mensagens, eventos e fluxos serão substituídos pelo modelo padrão. Suas perguntas atuais serão perdidas depois de salvar.')) return;
  const template = starterTemplate();
  state.config = { ...state.config, ...template };
  markDirty();
  state.page = 'messages';
  render();
  toast('Modelo aplicado. Revise os textos e clique em Salvar alterações.');
}

/* ---------------------------------------------------------- validation */

function validateBeforeSave(show = true) {
  const config = state.config;
  const issues = [];
  const push = (path, message, fix) => issues.push({ path, message, fix });

  const requiredStrings = ['officeName', 'assistantName', 'writingStyle', 'greeting', 'assistantNotice', 'privacyNotice', 'externalProviderNotice', 'areaQuestion', 'acknowledgementMessage', 'clarificationMessage', 'aiFallbackMessage', 'handoffMessage', 'audioRetryMessage', 'completionMessage', 'urgencyMessage', 'humanCommand', 'defaultProfileId', 'areaFieldId'];
  for (const path of requiredStrings) {
    const value = getPath(path);
    if (typeof value !== 'string' || !value.trim()) push(path, 'Campo obrigatório vazio.', 'Preencha este campo antes de salvar.');
  }
  if (!Array.isArray(config.profiles) || config.profiles.length === 0) push('profiles', 'Crie ao menos uma área.', 'Adicione uma área de atendimento.');

  (config.profiles || []).forEach((profile, profileIndex) => {
    for (const key of ['id', 'label']) if (!String(profile[key] || '').trim()) push(`profiles.${profileIndex}.${key}`, 'Campo obrigatório vazio.', 'Preencha este campo.');
    if (!profile.fields?.length) push(`profiles.${profileIndex}.fields`, 'A área precisa de uma pergunta.', 'Adicione ao menos uma pergunta.');
    (profile.fields || []).forEach((item, fieldIndex) => {
      for (const key of ['id', 'label', 'question']) if (!String(item[key] || '').trim()) push(`profiles.${profileIndex}.fields.${fieldIndex}.${key}`, 'Campo obrigatório vazio.', 'Preencha este campo.');
      if (['single_choice', 'multiple_choice'].includes(item.type) && !item.options?.length) push(`profiles.${profileIndex}.fields.${fieldIndex}.options`, 'Faltam opções de resposta.', 'Adicione ao menos uma opção.');
      if (item.askWhen?.fieldId && !item.askWhen?.value) push(`profiles.${profileIndex}.fields.${fieldIndex}.askWhen`, 'Condição sem valor.', 'Informe o valor da condição ou remova a condição.');
    });
    if (profile.fields?.length && !profile.fields.some((item) => item.id === config.areaFieldId && item.required)) {
      push('areaFieldId', `A área “${profile.label}” não possui o campo de área obrigatório.`, 'Inclua esse campo ou escolha outra área padrão.');
    }
  });

  (config.conditionalEvents || []).forEach((event, index) => {
    if (!String(event.name || '').trim()) push(`conditionalEvents.${index}.name`, 'Evento sem nome.', 'Dê um nome ao evento.');
    if (event.trigger === 'keyword' && !event.keywords?.length) push(`conditionalEvents.${index}.keywords`, 'Evento por palavra-chave sem palavras.', 'Adicione ao menos uma palavra ou troque o gatilho.');
    if (event.action === 'send_message' && !String(event.message || '').trim()) push(`conditionalEvents.${index}.message`, 'Evento de envio sem mensagem.', 'Escreva a mensagem ou mude a ação.');
  });

  (config.materials || []).forEach((material, index) => {
    for (const key of ['title', 'content']) if (!String(material[key] || '').trim()) push(`materials.${index}.${key}`, 'Material incompleto.', 'Preencha o título e o conteúdo ou remova o material.');
  });

  const numericRules = {
    maxCharsPerMessage: [80, 4000], maxMessagesPerTurn: [1, 4], maxFieldAttempts: [1, 5], maxAudioBytes: [1024, 25000000],
    maxHistoryMessages: [1, 50], workerPollMs: [100, 10000], maxMessagesPerContactPerDay: [1, 100000], maxMessagesPerContactPerMonth: [1, 1000000],
    maxMessagesSentPerDay: [1, 1000000], maxMessagesSentPerMonth: [1, 10000000], retentionDays: [1, 3650], typingSecondsPerCharacter: [0, 1],
  };
  for (const [key, [minimum, maximum]] of Object.entries(numericRules)) {
    const value = config[key];
    if (!Number.isFinite(value) || value < minimum || value > maximum) push(key, 'Valor fora do intervalo permitido.', `Informe um valor entre ${minimum} e ${maximum}.`);
  }
  for (const key of ['batchWindowSeconds', 'sendPartDelaySeconds', 'audioResponseDelaySeconds', 'audioTranscriptionTimeoutSeconds', 'minSecondsBetweenContactMessages']) {
    const value = config[key];
    if (!Number.isFinite(value) || value < 0) push(key, 'Duração inválida.', 'Informe uma duração em segundos.');
  }
  if ((config.aiProvider === 'gemini' || config.audioTranscriptionProvider === 'gemini') && String(config.externalProviderNotice || '').length > config.maxCharsPerMessage) {
    push('externalProviderNotice', 'O aviso do Gemini não cabe em um balão.', 'Reduza o aviso ou aumente o limite de caracteres por balão.');
  }

  document.querySelectorAll('.field.invalid').forEach((node) => node.classList.remove('invalid'));
  const panel = byId('validation-errors');
  if (issues.length && show) {
    for (const issue of issues) markInvalid(issue.path);
    panel.classList.remove('hidden');
    panel.innerHTML = `<strong>Há informações para corrigir antes de salvar (${issues.length}).</strong><ul>${issues.slice(0, 12).map((issue) => `<li><button type="button" class="error-link" data-error-path="${escapeHtml(issue.path)}">${escapeHtml(describePath(issue.path))}</button>: ${escapeHtml(issue.message)} ${escapeHtml(issue.fix)}</li>`).join('')}</ul>`;
    attachErrorLinks(panel);
  } else if (!issues.length) {
    panel.classList.add('hidden');
    panel.innerHTML = '';
  }
  return issues;
}

function markInvalid(path) {
  const escaped = CSS.escape(path);
  const element = content.querySelector(`[data-path="${escaped}"]`) || content.querySelector(`[data-list-path="${escaped}"]`);
  element?.closest('.field')?.classList.add('invalid');
}

function attachErrorLinks(panel) {
  panel.querySelectorAll('[data-error-path]').forEach((button) => button.addEventListener('click', () => {
    const path = button.dataset.errorPath || '';
    const parts = path.split('.');
    if (parts[0] === 'profiles') { state.page = 'flow'; state.profileIndex = Number(parts[1]) || 0; }
    else if (['conditionalEvents', 'handoffKeywords', 'legalQuestionKeywords', 'forbiddenTopics', 'humanCommand'].includes(parts[0])) state.page = 'events';
    else if (['materials', 'writingStyle', 'officeMemory', 'conversationInstructions', 'conversationStyleSamples'].includes(parts[0])) state.page = 'knowledge';
    else if (['aiProvider', 'audioTranscriptionProvider'].includes(parts[0])) state.page = 'overview';
    else state.page = 'messages';
    render();
    markInvalid(path);
    const element = content.querySelector(`[data-path="${CSS.escape(path)}"]`) || content.querySelector(`[data-list-path="${CSS.escape(path)}"]`);
    element?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }));
}

const PATH_TITLES = {
  officeName: 'Nome do escritório', assistantName: 'Nome do assistente', writingStyle: 'Tom de voz',
  greeting: 'Mensagem de abertura', assistantNotice: 'Aviso de assistente virtual', privacyNotice: 'Aviso de privacidade',
  externalProviderNotice: 'Aviso de processamento externo', areaQuestion: 'Pergunta da área', areaFieldId: 'Campo da área',
  acknowledgementMessage: 'Confirmação após resposta', clarificationMessage: 'Pedido de esclarecimento',
  aiFallbackMessage: 'Falha da IA', handoffMessage: 'Encaminhamento', audioRetryMessage: 'Áudio sem transcrição',
  completionMessage: 'Triagem concluída', urgencyMessage: 'Urgência', humanCommand: 'Comando humano',
  handoffKeywords: 'Palavras de urgência', legalQuestionKeywords: 'Perguntas jurídicas', forbiddenTopics: 'Temas reservados',
  conditionalEvents: 'Eventos da conversa', materials: 'Materiais internos', fields: 'Perguntas da área',
  askWhen: 'Condição da pergunta', fieldId: 'Pergunta da condição', title: 'Título', content: 'Conteúdo',
  defaultProfileId: 'Área padrão', id: 'Identificador', label: 'Nome do campo', question: 'Pergunta enviada',
  options: 'Opções de resposta', name: 'Nome do evento', keywords: 'Palavras do evento', message: 'Mensagem do evento',
  maxCharsPerMessage: 'Caracteres por balão', maxMessagesPerTurn: 'Balões por turno', maxFieldAttempts: 'Tentativas por pergunta',
  batchWindowSeconds: 'Janela de agrupamento', sendPartDelaySeconds: 'Intervalo entre balões', typingSecondsPerCharacter: 'Digitação por caractere',
  retentionDays: 'Retenção de dados', simulateTyping: 'Simular digitação',
};

function describePath(path) {
  const parts = (path || '').split('.');
  let label = 'Configuração';
  if (parts[0] === 'profiles' && Number.isInteger(Number(parts[1]))) {
    const profile = state.config.profiles[Number(parts[1])];
    label = `Fluxos → ${profile?.label || `Área ${Number(parts[1]) + 1}`}`;
    if (parts[2] === 'fields' && Number.isInteger(Number(parts[3]))) {
      const item = profile?.fields?.[Number(parts[3])];
      label += ` → ${item?.label || `Pergunta ${Number(parts[3]) + 1}`}`;
      parts.splice(0, 4);
    } else parts.splice(0, 2);
  }
  if (parts[0] === 'conditionalEvents' && Number.isInteger(Number(parts[1]))) {
    const event = state.config.conditionalEvents?.[Number(parts[1])];
    label = `Eventos → ${event?.name || `Evento ${Number(parts[1]) + 1}`}`;
    parts.splice(0, 2);
  }
  if (parts[0] === 'materials' && Number.isInteger(Number(parts[1]))) {
    const material = state.config.materials?.[Number(parts[1])];
    label = `Materiais → ${material?.title || `Material ${Number(parts[1]) + 1}`}`;
    parts.splice(0, 2);
  }
  const last = parts.at(-1) || '';
  const suffix = PATH_TITLES[last] || last.replaceAll(/[A-Z]/g, (letter) => ` ${letter.toLowerCase()}`);
  return label === 'Configuração' ? suffix : `${label} → ${suffix}`;
}

/* ------------------------------------------------------------------ save */

async function save() {
  if (validateBeforeSave().length) { toast('Corrija os itens indicados antes de salvar.', true); return; }
  try {
    const normalized = {
      ...state.config,
      profiles: state.config.profiles.map((profile) => ({
        ...profile,
        fields: profile.fields.map((item) => {
          const copy = { ...item };
          if (!copy.askWhen?.fieldId || !copy.askWhen?.value) delete copy.askWhen;
          return copy;
        }),
      })),
      conditionalEvents: (state.config.conditionalEvents || []).map((event) => ({
        ...event,
        keywords: event.trigger === 'keyword' ? event.keywords || [] : [],
        message: event.message || '',
      })),
    };
    const result = await api('/api/config', { method: 'PUT', body: JSON.stringify(normalized) });
    state.config = await api('/api/config');
    state.dirty = false;
    byId('save-state').textContent = `Salvo às ${new Date(result.savedAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`;
    byId('save-state').classList.remove('dirty');
    byId('validation-errors').classList.add('hidden');
    render();
    toast('Configurações salvas e aplicadas ao atendimento.');
  } catch (error) {
    const panel = byId('validation-errors');
    if (error.details?.length) {
      for (const issue of error.details) markInvalid(issue.path);
      panel.classList.remove('hidden');
      panel.innerHTML = `<strong>O servidor encontrou informações para corrigir.</strong><ul>${error.details.map((issue) => `<li><button type="button" class="error-link" data-error-path="${escapeHtml(issue.path)}">${escapeHtml(describePath(issue.path))}</button>: ${escapeHtml(issue.message)} ${escapeHtml(issue.fix || 'Revise este campo.')}</li>`).join('')}</ul>`;
      attachErrorLinks(panel);
    } else {
      panel.classList.remove('hidden');
      panel.textContent = error.message;
    }
    toast('Veja a caixa de erro no topo da página.', true);
  }
}

/* ------------------------------------------------------------- bootstrap */

async function openApp() {
  state.config = await api('/api/config');
  login.classList.add('hidden');
  app.classList.remove('hidden');
  render();
}

byId('login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  byId('login-error').textContent = '';
  try {
    await api('/api/login', { method: 'POST', body: JSON.stringify({ password: byId('password').value }) });
    await openApp();
  } catch (error) { byId('login-error').textContent = error.message; }
});

byId('nav').addEventListener('click', (event) => {
  const button = event.target.closest('[data-page]');
  if (!button) return;
  const discard = state.dirty;
  if (discard && !confirm('Você tem alterações não salvas. Trocar de tela e descartar?')) return;
  state.page = button.dataset.page;
  if (discard) {
    state.dirty = false;
    byId('save-state').textContent = 'Tudo salvo';
    byId('save-state').classList.remove('dirty');
    void reloadConfig();
    return;
  }
  render();
});

byId('save').addEventListener('click', save);
byId('logout').addEventListener('click', async () => { await api('/api/logout', { method: 'POST' }); location.reload(); });
byId('restore').addEventListener('click', async () => {
  if (!confirm('Restaurar a última versão salva? A configuração atual será guardada antes.')) return;
  try {
    await api('/api/restore-last', { method: 'POST', body: '{}' });
    state.config = await api('/api/config');
    state.dirty = false;
    byId('save-state').textContent = 'Tudo salvo';
    byId('save-state').classList.remove('dirty');
    render();
    toast('Versão anterior restaurada.');
  } catch (error) { toast(error.message, true); }
});

async function reloadConfig() {
  try { state.config = await api('/api/config'); render(); } catch { /* sessão encerrada */ }
}

window.addEventListener('beforeunload', (event) => {
  if (!state.dirty) return;
  event.preventDefault();
  event.returnValue = '';
});

(async () => {
  try {
    const session = await api('/api/session');
    if (session.authenticated) await openApp();
    else login.classList.remove('hidden');
  } catch { login.classList.remove('hidden'); }
})();
