const byId = (id) => document.getElementById(id);
const app = byId('app');
const login = byId('login');
const content = byId('content');
const TITLES = { overview:'Visão geral', behavior:'Comportamento', flow:'Fluxos e perguntas', messages:'Mensagens', knowledge:'Instruções e materiais', preview:'Testar conversa', whatsapp:'Conexão WhatsApp', contacts:'Contatos e listas', diagnostics:'Fila e diagnósticos' };
let config = null;
let page = 'overview';
let profileIndex = 0;
let dirty = false;
let whatsappPoller = null;

async function api(path, options = {}) {
  const formData=typeof FormData!=='undefined'&&options.body instanceof FormData;
  const response = await fetch(path, { credentials:'same-origin', ...options, headers:{ ...(options.body&&!formData ? {'Content-Type':'application/json'} : {}), ...(options.headers || {}) } });
  const payload = response.status === 204 ? {} : await response.json().catch(() => ({}));
  if (!response.ok) { const error = new Error(payload.error || `Falha na solicitação (${response.status}).`); error.details=payload.details||[]; throw error; }
  return payload;
}

function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, (char) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char])); }
function newlineList(value) { return (value || []).join('\n'); }
function parseList(value) { return value.split('\n').map((item) => item.trim()).filter(Boolean); }
function input(label, path, value, opts = {}) {
  const cls = opts.full ? ' full-width' : '';
  const help = opts.help ? `<small>${escapeHtml(opts.help)}</small>` : '';
  const attrs = opts.attrs || '';
  return `<div class="control${cls}"><label>${escapeHtml(label)}</label><input data-path="${path}" ${attrs} value="${escapeHtml(value)}" />${help}</div>`;
}
function numberInput(label, path, value, min=null, max=null, help='',step='1') { const bounds=`${min!==null?` min="${min}"`:''}${max!==null?` max="${max}"`:''}`; return input(label,path,value,{attrs:`type="number" step="${step}"${bounds}`,help}); }
function textarea(label,path,value,help='',rows=4) { return `<div class="control full-width"><label>${escapeHtml(label)}</label><textarea data-path="${path}" rows="${rows}">${escapeHtml(value)}</textarea>${help?`<small>${escapeHtml(help)}</small>`:''}</div>`; }
function select(label,path,value,options,help='') { return `<div class="control"><label>${escapeHtml(label)}</label><select data-path="${path}">${options.map(([v,l])=>`<option value="${escapeHtml(v)}" ${v===value?'selected':''}>${escapeHtml(l)}</option>`).join('')}</select>${help?`<small>${escapeHtml(help)}</small>`:''}</div>`; }
function toggle(label,path,checked,help='') { return `<div class="toggle-row"><div class="toggle-copy"><strong>${escapeHtml(label)}</strong><small>${escapeHtml(help)}</small></div><label class="switch"><input type="checkbox" data-path="${path}" ${checked?'checked':''}><span></span></label></div>`; }
function heading(kicker,title,description,action='') { return `<div class="page-heading"><div><p class="eyebrow">${escapeHtml(kicker)}</p><h1>${escapeHtml(title)}</h1><p>${escapeHtml(description)}</p></div>${action}</div>`; }
function markDirty() { dirty=true; byId('save-state').textContent='Alterações não salvas'; }
function setPath(path,value) { const parts=path.split('.'); let target=config; for(const part of parts.slice(0,-1)){if(target[part]===undefined||target[part]===null)target[part]={};target=target[part];} target[parts.at(-1)]=value; markDirty(); }

function render() {
  if(whatsappPoller){clearInterval(whatsappPoller);whatsappPoller=null;}
  byId('page-title').textContent = TITLES[page];
  document.querySelectorAll('.nav-item').forEach((item)=>item.classList.toggle('active',item.dataset.page===page));
  if(page==='overview') renderOverview();
  if(page==='behavior') renderBehavior();
  if(page==='flow') renderFlow();
  if(page==='messages') renderMessages();
  if(page==='knowledge') renderKnowledge();
  if(page==='preview') renderPreview();
  if(page==='whatsapp') renderWhatsApp();
  if(page==='contacts') void renderContacts();
  if(page==='diagnostics') void renderDiagnostics();
  content.querySelectorAll('[data-path]').forEach((el)=>{
    const eventName=['checkbox','number','select-one','radio'].includes(el.type)?'change':'input';
    el.addEventListener(eventName,()=>{
      const value=el.type==='checkbox'?el.checked:el.type==='number'?Number(el.value):el.value;
      setPath(el.dataset.path,value);
      if(!byId('validation-errors').classList.contains('hidden')) validateBeforeSave(false);
      if(el.dataset.path.endsWith('.type')) renderFlow();
      if(el.dataset.path==='areaFieldId') renderMessages();
      if(page==='preview') renderPreview();
    });
  });
  content.querySelectorAll('[data-list-path]').forEach((el)=>el.addEventListener('input',()=>{setPath(el.dataset.listPath,parseList(el.value));}));
  content.querySelectorAll('[data-action]').forEach((el)=>el.addEventListener('click',()=>action(el.dataset.action,el.dataset.index)));
  content.querySelectorAll('[data-contact-assignment]').forEach((el)=>el.addEventListener('change',()=>updateContact(el.dataset.jid,el.value)));
}

function renderWhatsApp() {
  content.innerHTML=heading('OPERAÇÃO','Conexão WhatsApp','Acompanhe a sessão usada pelo agente, faça o pareamento e confira o mecanismo de integração.')+
    `<div class="grid two"><div class="card"><div class="card-title-row"><h2>Estado da sessão</h2><span id="whatsapp-status-badge" class="pill">Consultando…</span></div><p id="whatsapp-status-detail" class="card-description">Consultando o provedor configurado…</p><div class="status-actions"><button class="button small" data-action="refresh-whatsapp">Atualizar estado</button><button id="whatsapp-restart" class="button small danger hidden" data-action="restart-whatsapp">Reiniciar sessão</button></div><div id="whatsapp-provider-help" class="notice">A leitura do status pode levar alguns segundos.</div></div><div id="whatsapp-qr-card" class="card hidden"><h2>Parear este número</h2><p class="card-description">No WhatsApp do número que será usado: <b>Aparelhos conectados → Conectar aparelho</b>. Escaneie o QR abaixo.</p><div id="whatsapp-qr-wrap" class="qr-wrap"><img id="whatsapp-qr" alt="QR de pareamento da sessão WhatsApp" /></div><p class="help">O QR é temporário e só é exibido para quem entrou no painel. Se expirar, atualize o estado para gerar outro.</p></div></div><div class="notice section-card">WAHA, assim como Baileys, conecta pelo protocolo do WhatsApp Web e não é a API oficial da Meta. Use um número de teste e considere o risco de desconexão ou restrição da conta.</div>`;
  content.innerHTML+=`<div class="card section-card"><h2>Provedor WhatsApp</h2><p class="card-description">A alteração salva a configuração e troca a conexão ativa. Os segredos permanecem no ambiente do servidor.</p>${select('Integração','whatsappProvider',config.whatsappProvider,[['meta','Meta Cloud API (oficial)'],['waha','WAHA (teste/local)'],['baileys','Baileys (legado)']],'Meta exige credenciais e webhook público HTTPS. WAHA e Baileys usam sessão WhatsApp Web. A elegibilidade é interna na Meta e baseada em listas no WAHA/Baileys.')}</div>`;
  void refreshWhatsAppStatus();
  whatsappPoller=setInterval(()=>void refreshWhatsAppStatus(),5000);
}

async function refreshWhatsAppStatus() {
  const badge=byId('whatsapp-status-badge');
  if(!badge)return;
  try{
    const status=await api('/api/whatsapp/status');
    const state=String(status.state||'UNKNOWN').toUpperCase();
    const provider=status.provider==='waha'?'WAHA':status.provider==='meta'?'Meta Cloud API':'Baileys';
    const names={WORKING:'Conectado',CONFIGURED:'Configurado · sem teste de saúde',SCAN_QR_CODE:'Aguardando leitura do QR',STARTING:'Iniciando',STOPPED:'Parado',FAILED:'Falha na sessão',DISCONNECTED:'Desconectado',INITIALIZING:'Inicializando'};
    badge.textContent=names[state]||state;
    badge.classList.toggle('status-online',Boolean(status.connected)&&state!=='CONFIGURED');
    const details=[provider,status.session?`sessão ${status.session}`:'',status.engine?`mecanismo ${status.engine}`:'',status.account?`conta ${status.account}`:''].filter(Boolean).join(' · ');
    byId('whatsapp-status-detail').textContent=details;
    const help=byId('whatsapp-provider-help');
    const restart=byId('whatsapp-restart');
    const qrCard=byId('whatsapp-qr-card');
    if(status.provider==='waha'&&state==='SCAN_QR_CODE'){
      help.textContent='Abra o WhatsApp no celular, escolha Aparelhos conectados e leia o QR. Mantenha o painel aberto até o status mudar para Conectado.';
      qrCard.classList.remove('hidden');
      byId('whatsapp-qr').src=`/api/whatsapp/qr?t=${Date.now()}`;
    }else{
      qrCard.classList.add('hidden');
      byId('whatsapp-qr').removeAttribute('src');
      if(status.provider==='baileys')help.textContent='Baileys está ativo. O QR de primeiro pareamento é exibido no terminal que iniciou a aplicação.';
      else if(status.provider==='meta')help.textContent='Meta Cloud API configurada. O provedor não usa QR nem etiquetas; a elegibilidade é controlada pela lista interna deste painel.';
      else if(state==='WORKING')help.textContent='A sessão está ativa. O agente pode receber mensagens, transcrever áudio e aplicar etiquetas conforme as instruções configuradas.';
      else if(state==='FAILED'||state==='STOPPED')help.textContent='A sessão não está ativa. Consulte os logs do WAHA e, se necessário, reinicie a sessão.';
      else help.textContent='A sessão ainda está iniciando ou reconectando. O painel atualizará este estado automaticamente.';
    }
    restart.classList.toggle('hidden',status.provider!=='waha'||!['FAILED','STOPPED'].includes(state));
  }catch(error){
    badge.textContent='Indisponível';
    badge.classList.remove('status-online');
    byId('whatsapp-status-detail').textContent=error.message;
    byId('whatsapp-provider-help').textContent='Não foi possível consultar o provedor configurado. Verifique a conexão e as credenciais no ambiente do servidor.';
    byId('whatsapp-qr-card').classList.add('hidden');
    byId('whatsapp-restart').classList.add('hidden');
    byId('whatsapp-qr').removeAttribute('src');
  }
}

function renderOverview() {
  const profile=config.profiles.find((item)=>item.id===config.defaultProfileId) || config.profiles[0];
  content.innerHTML=heading('SEU ATENDIMENTO','Uma recepção clara, do primeiro oi ao encaminhamento.','Configure o jeito de conversar, as perguntas e os limites do agente. As mudanças são aplicadas sem reiniciar o serviço.')+
    `<div class="grid three"><div class="card stat-card"><div class="stat-label">ÁREA DE ATENDIMENTO</div><div class="stat-value">${escapeHtml(profile.label)}</div><div class="stat-note">Fluxo padrão selecionado</div></div><div class="card stat-card"><div class="stat-label">PERGUNTAS CONFIGURADAS</div><div class="stat-value">${profile.fields.length}</div><div class="stat-note">Em ${config.profiles.length} fluxo(s)</div></div><div class="card stat-card"><div class="stat-label">MENSAGENS POR VEZ</div><div class="stat-value">Até ${config.maxMessagesPerTurn}</div><div class="stat-note">Com pausa entre os balões</div></div></div>`+
    `<div class="grid two section-card"><div class="card"><div class="card-title-row"><h2>Ritmo do atendimento</h2><span class="pill">WhatsApp</span></div><p class="card-description">Responda somente a mensagens recebidas e com autorização confirmada.</p>${select('Primeira mensagem recebida','firstMessagePolicy',config.firstMessagePolicy,[['explicit','Aguardar inclusão explícita na lista Bot'],['auto','Iniciar triagem automaticamente']],'O modo automático só inicia após a primeira mensagem recebida. Atribuir uma lista nunca dispara campanha.')}${toggle('Simular “escrevendo…”','simulateTyping',config.simulateTyping,'Mostra presença de digitação antes de enviar cada balão, quando o provedor oferece esse recurso.')}</div><div class="card"><div class="card-title-row"><h2>Proteção do atendimento</h2><span class="pill">Controle do escritório</span></div><p class="card-description">O agente faz apenas acolhimento e coleta inicial; não presta orientação jurídica individual.</p><div class="notice green">O assistente se identifica, pede somente os dados configurados e interrompe a triagem quando precisa de avaliação humana.</div><button class="button section-card" data-action="goto-behavior">Revisar comportamento →</button></div></div>`;
}

function renderBehavior() {
  content.innerHTML=heading('COMPORTAMENTO','Defina o ritmo e os limites.','Ajuste a espera, a simulação de digitação, o tamanho das mensagens e a quem o agente responde.')+
    `<div class="grid two"><div class="card"><h2>Quem recebe resposta</h2><p class="card-description">O estado BOT, a elegibilidade e a sincronização precisam estar confirmados. HUMANO e PAUSADO sempre prevalecem.</p>${select('Primeira mensagem recebida','firstMessagePolicy',config.firstMessagePolicy,[['explicit','Aguardar inclusão explícita na lista Bot'],['auto','Iniciar triagem automaticamente']],'Uma mensagem nova não remove pausa manual. A inclusão em Bot nunca inicia conversa sem mensagem recebida.')}${select('Provedor de IA','aiProvider',config.aiProvider,[['ollama','Ollama local'],['gemini','Gemini externo']],'Ollama é a opção padrão local; Gemini envia as mensagens necessárias à extração ao Google.')}${select('Transcrição de áudio','audioTranscriptionProvider',config.audioTranscriptionProvider,[['disabled','Desativada'],['gemini','Gemini externo']],'Com Gemini, o áudio será transmitido para transcrição; o padrão mantém áudio desativado.')}</div><div class="card"><h2>Presença</h2><p class="card-description">Use somente os recursos disponíveis no provedor ativo.</p>${toggle('Mostrar “escrevendo…”','simulateTyping',config.simulateTyping,'WAHA e Baileys podem exibir presença de digitação; Meta Cloud API não oferece esse recurso no adaptador atual.')}${numberInput('Tempo de digitação por caractere (segundos)','typingSecondsPerCharacter',config.typingSecondsPerCharacter,0,null,'Usado pelos provedores que oferecem presença de digitação.','any')}<div class="notice">Mantenha aviso de privacidade atualizado antes de selecionar qualquer provedor externo.</div></div></div>`+
    `<div class="card section-card"><h2>Cadência, limites e retenção</h2><p class="card-description">Defina esperas, janela de agrupamento, cota de mensagens e prazo de retenção.</p><div class="field-grid">${numberInput('Aguardar para agrupar mensagens (segundos)','batchWindowSeconds',config.batchWindowSeconds,0,null,'A janela reinicia quando chegam novas mensagens da mesma conversa.','any')}${numberInput('Intervalo entre balões do bot (segundos)','sendPartDelaySeconds',config.sendPartDelaySeconds,0,null,'Pausa entre uma mensagem do bot e a seguinte.','any')}${numberInput('Intervalo mínimo por contato (segundos)','minSecondsBetweenContactMessages',config.minSecondsBetweenContactMessages,0,null,'Limita a cadência de envios ao mesmo contato.','any')}${numberInput('Máximo por contato em 24 horas','maxMessagesPerContactPerDay',config.maxMessagesPerContactPerDay,1,100000)}${numberInput('Máximo por contato em 30 dias','maxMessagesPerContactPerMonth',config.maxMessagesPerContactPerMonth,1,1000000)}${numberInput('Máximo total em 24 horas','maxMessagesSentPerDay',config.maxMessagesSentPerDay,1,1000000)}${numberInput('Máximo total em 30 dias','maxMessagesSentPerMonth',config.maxMessagesSentPerMonth,1,10000000)}${numberInput('Caracteres máximos por balão','maxCharsPerMessage',config.maxCharsPerMessage,80,4000,'O sistema limita cada balão sem pedir ao modelo para contornar limites do provedor.')}${numberInput('Máximo de balões por resposta','maxMessagesPerTurn',config.maxMessagesPerTurn,1,4)}${numberInput('Tentativas antes de encaminhar','maxFieldAttempts',config.maxFieldAttempts,1,5,'Se o campo não for identificado, a triagem pede esclarecimento e depois encaminha.')}${numberInput('Reter conversas e diagnósticos (dias)','retentionDays',config.retentionDays,1,3650,'Mensagens, contatos, filas concluídas e diagnósticos serão excluídos após este prazo.')}${textarea('Termos que indicam urgência (um por linha)','handoffKeywords',newlineList(config.handoffKeywords),'Ao encontrar um termo, a automação pausa e encaminha à equipe.',4)}${textarea('Perguntas jurídicas que devem ir à equipe (uma por linha)','legalQuestionKeywords',newlineList(config.legalQuestionKeywords),'Use expressões para dúvidas individuais sobre direitos, prazos, medidas ou resultados.',4)}${input('Comando para pedir uma pessoa','humanCommand',config.humanCommand,{help:'O contato pode enviar este comando para pausar a automação e solicitar atendimento humano.'})}</div></div>`;
  const urgent = content.querySelector('[data-path="handoffKeywords"]'); if(urgent){urgent.dataset.listPath='handoffKeywords';urgent.removeAttribute('data-path');}
  const legal = content.querySelector('[data-path="legalQuestionKeywords"]'); if(legal){legal.dataset.listPath='legalQuestionKeywords';legal.removeAttribute('data-path');}
}

function renderFlow() {
  if(!config.profiles.length) config.profiles=[{id:'triagem',label:'Nova triagem',triggers:[],fields:[]}];
  profileIndex=Math.min(profileIndex,config.profiles.length-1);
  const profile=config.profiles[profileIndex];
  const profileOptions=config.profiles.map((item,index)=>[String(index),item.label]);
  const cards=profile.fields.map((field,index)=>questionCard(field,index,profile)).join('');
  content.innerHTML=heading('CONSTRUTOR DE ATENDIMENTO','Pergunte só o que ajuda a encaminhar.','Crie áreas de atendimento, ordene perguntas e defina condições, formatos e respostas esperadas.')+
    `<div class="profile-bar"><select id="profile-select" class="inline-input">${profileOptions.map(([v,l])=>`<option value="${v}" ${Number(v)===profileIndex?'selected':''}>${escapeHtml(l)}</option>`).join('')}</select><button class="button small" data-action="add-profile">＋ Nova área</button><button class="button small danger" data-action="remove-profile">Remover área</button><div class="spacer"></div><label class="checkboxline"><input type="radio" name="default-profile" ${profile.id===config.defaultProfileId?'checked':''} data-action="make-default"> Usar como padrão</label></div>`+
    `<div class="card"><div class="field-grid">${input('Nome da área','profiles.'+profileIndex+'.label',profile.label)}${input('Palavras para reconhecer esta área (uma por linha)','profiles.'+profileIndex+'.triggers',newlineList(profile.triggers),{help:'Se a mensagem inicial contiver um termo, o fluxo correspondente pode ser selecionado.'})}</div><div class="rule"></div><div class="card-title-row"><div><h2>Perguntas deste fluxo</h2><p class="card-description" style="margin:5px 0 0">As perguntas aparecem na ordem abaixo.</p></div><button class="button small" data-action="add-field">＋ Adicionar pergunta</button></div>${cards||'<div class="empty-state">Adicione a primeira pergunta para este fluxo.</div>'}</div>`;
  const triggers=content.querySelector(`[data-path="profiles.${profileIndex}.triggers"]`);
  if(triggers){triggers.dataset.listPath=`profiles.${profileIndex}.triggers`;triggers.removeAttribute('data-path');}
  const selectElement=byId('profile-select'); if(selectElement) selectElement.addEventListener('change',()=>{profileIndex=Number(selectElement.value);renderFlow();});
  content.querySelectorAll('[data-action="make-default"]').forEach((radio)=>radio.addEventListener('change',()=>{config.defaultProfileId=profile.id;markDirty();}));
}

function questionCard(field,index,profile) {
  const base=`profiles.${profileIndex}.fields.${index}`;
  const typeOptions=[['open_text','Resposta aberta'],['yes_no','Sim ou não'],['single_choice','Escolha única'],['multiple_choice','Múltipla escolha'],['date','Data'],['number','Número']];
  const choices=['single_choice','multiple_choice'].includes(field.type)?textarea('Opções disponíveis (uma por linha)',base+'.options',newlineList(field.options),'A pergunta apresentará estas opções para a pessoa escolher.',3).replace('data-path=','data-list-path='):'';
  const conditionOptions=[['','Sempre perguntar'],...profile.fields.filter((other)=>other.id!==field.id).map((other)=>[other.id,`Quando “${other.label}”`])];
  const condition=select('Condição',base+'.askWhen.fieldId',field.askWhen?.fieldId||'',conditionOptions,'Se não corresponder ao valor definido, a pergunta será ignorada.');
  const conditionValue=input('Valor para a condição',base+'.askWhen.value',field.askWhen?.value||'');
  return `<div class="question-card"><div class="question-head"><span class="question-number">${String(index+1).padStart(2,'0')}</span><strong>${escapeHtml(field.label||'Nova pergunta')}</strong><button class="button small" data-action="up-field" data-index="${index}" ${index===0?'disabled':''}>↑</button><button class="button small" data-action="down-field" data-index="${index}" ${index===profile.fields.length-1?'disabled':''}>↓</button><button class="button small danger" data-action="remove-field" data-index="${index}">Remover</button></div><div class="field-grid">${input('Identificador único',base+'.id',field.id)}${input('Nome do campo',base+'.label',field.label)}${textarea('Pergunta enviada ao contato',base+'.question',field.question,'A pergunta exibida quando este campo for o próximo.',2)}${select('Tipo de resposta',base+'.type',field.type,typeOptions)}${textarea('Estrutura ou orientação para interpretar a resposta',base+'.structure',field.structure||'','Ex.: peça data aproximada e cidade; aceite que a pessoa não saiba.',2)}${choices}${condition}${conditionValue}<div class="control"><label>Obrigatoriedade</label><label class="checkboxline"><input type="checkbox" data-path="${base}.required" ${field.required?'checked':''}> Campo necessário para concluir a triagem</label><label class="checkboxline"><input type="checkbox" data-path="${base}.contactName" ${field.contactName?'checked':''}> Usar resposta para renomear o contato</label></div></div></div>`;
}

function renderMessages() {
  const profile=config.profiles.find((item)=>item.id===config.defaultProfileId)||config.profiles[0];
  const fields=profile.fields.map((field)=>[field.id,field.label]);
  content.innerHTML=heading('MENSAGENS','A primeira impressão importa.','Configure a saudação, a pergunta de área e as respostas de encaminhamento. Veja o resultado em uma prévia.')+
    `<div class="grid two"><div class="card"><h2>Identidade e abertura</h2><p class="card-description">A abertura informa que o sistema é virtual, limita o atendimento à triagem e inclui aviso de privacidade.</p><div class="field-grid">${input('Nome do escritório','officeName',config.officeName)}${input('Nome do assistente','assistantName',config.assistantName)}${textarea('Mensagem de abertura','greeting',config.greeting,'Enviada apenas em resposta a uma mensagem recebida.',3)}${textarea('Aviso de assistente virtual','assistantNotice',config.assistantNotice,'Não diga que um advogado já analisou o caso.',3)}${textarea('Aviso de privacidade','privacyNotice',config.privacyNotice,'Peça apenas dados necessários e não solicite documentos ou dados sensíveis no início.',3)}${textarea('Aviso de processamento externo','externalProviderNotice',config.externalProviderNotice,'Enviado antes de qualquer conteúdo ser processado pelo Gemini; a primeira mensagem fica fora da IA.',3)}${textarea('Pergunta sobre o assunto','areaQuestion',config.areaQuestion,'Pergunta configurada enviada na abertura ou quando necessário.',3)}${textarea('Confirmação fixa','acknowledgementMessage',config.acknowledgementMessage,'Texto determinístico enviado depois de uma resposta identificada; a IA não redige mensagens.',2)}${select('Campo que guarda a área','areaFieldId',config.areaFieldId,fields,'A resposta fica salva neste campo nos fluxos.')}</div></div><div class="card"><h2>Esclarecimento e encaminhamento</h2><p class="card-description">Use mensagens fixas para não inventar respostas quando a extração falhar ou houver dúvida.</p><div class="field-grid">${textarea('Pedido de esclarecimento','clarificationMessage',config.clarificationMessage,'Enviado quando a resposta não corresponde ao campo perguntado.',3)}${textarea('Falha ou baixa confiança da IA','aiFallbackMessage',config.aiFallbackMessage,'A triagem pausa e encaminha para a equipe.',3)}${textarea('Solicitação de atendimento humano','handoffMessage',config.handoffMessage,'',3)}${textarea('Mensagem de urgência','urgencyMessage',config.urgencyMessage,'',3)}${textarea('Triagem concluída','completionMessage',config.completionMessage,'',3)}${textarea('Áudio não transcrito','audioRetryMessage',config.audioRetryMessage,'Áudio fica desativado por padrão; se habilitar a transcrição, Gemini recebe o áudio.',3)}</div></div></div>`;
}

function renderKnowledge() {
  const materials=(config.materials||[]).map((material,index)=>`<div class="material-card"><div class="material-head"><div class="control"><label>Título do material</label><input data-path="materials.${index}.title" value="${escapeHtml(material.title)}"></div><button class="button small danger" data-action="remove-material" data-index="${index}">Remover</button></div><div class="control"><label>Conteúdo de apoio</label><textarea rows="5" data-path="materials.${index}.content">${escapeHtml(material.content)}</textarea><small>Use informações aprovadas pelo escritório. Evite dados de clientes e documentos de casos reais.</small></div></div>`).join('');
  content.innerHTML=heading('ORIENTAÇÕES DO ESCRITÓRIO','Configure a triagem sem gerar aconselhamento.','O modelo local extrai somente os campos configurados. Mensagens ao contato vêm de textos fixos e perguntas aprovadas pelo escritório.')+
    `<div class="grid two"><div class="card"><h2>Tom e limites</h2><p class="card-description">As mensagens do bot usam os textos fixos editáveis em “Mensagens”. Esta nota não é enviada ao modelo.</p>${textarea('Nota de redação para a equipe','writingStyle',config.writingStyle,'Orientação para quem revisa os textos fixos.',7)}<div class="rule"></div>${textarea('Temas a encaminhar (um por linha)','forbiddenTopics',newlineList(config.forbiddenTopics),'Se a mensagem corresponder a um destes termos, a automação encaminha à equipe.',5)}</div><div class="card"><h2>Informações do escritório</h2><p class="card-description">Notas de referência para a equipe. O conteúdo não é enviado ao modelo.</p>${textarea('Contexto interno','officeMemory',config.officeMemory||'','Não inclua dados de clientes.',8)}<div class="notice">As respostas ficam no SQLite local para continuidade e encaminhamento; acesso ao painel é protegido por senha.</div></div></div>`+
    `<div class="card section-card"><div class="card-title-row"><div><h2>Materiais internos</h2><p class="card-description" style="margin:5px 0 0">Mantenha referências de apoio para a equipe. O bot não envia esses conteúdos ao modelo.</p></div><button class="button small" data-action="add-material">＋ Adicionar texto</button></div><div class="field-grid"><div class="control full-width"><label for="material-files">Arquivos para importar</label><input id="material-files" type="file" multiple accept=".pdf,.txt,.md,.markdown,.csv,.json,.docx,.zip,application/pdf,application/zip"><small>Formatos: PDF, TXT, MD, CSV, JSON e DOCX. Dentro de ZIP, os mesmos formatos. PDFs digitalizados exigem OCR e não serão lidos. Limite conjunto de 20 materiais e 20.000 caracteres.</small></div><div><button class="button primary" data-action="import-materials">Importar arquivos selecionados</button></div></div><div id="material-import-result"></div>${materials||'<div class="empty-state">Nenhum material adicionado.</div>'}<div class="notice">Não inclua dados pessoais nos materiais internos.</div></div>`;
  const doNotSay=content.querySelector('[data-path="forbiddenTopics"]'); if(doNotSay){doNotSay.dataset.listPath='forbiddenTopics';doNotSay.removeAttribute('data-path');}
}

function renderPreview() {
  const profile=config.profiles.find((item)=>item.id===config.defaultProfileId)||config.profiles[0];
  const firstQuestion=config.areaQuestion||profile.fields[0]?.question||'Qual é o assunto?';
  const contactHasArea=byId('preview-area')?.checked||false;
  const usesExternal=config.aiProvider==='gemini'||config.audioTranscriptionProvider==='gemini';
  const intro=[config.greeting,config.assistantNotice,config.privacyNotice].filter(Boolean).join(' ');
  const messages=usesExternal?[config.externalProviderNotice]:[intro,contactHasArea?(profile.fields.find((field)=>field.id!==config.areaFieldId)?.question||'Como posso ajudar?'):firstQuestion];
  const opening=messages.length<=config.maxMessagesPerTurn?messages:[...messages.slice(0,config.maxMessagesPerTurn-1),messages.slice(config.maxMessagesPerTurn-1).join('\n\n')];
  const bubbles=opening.map((text)=>`<div class="bubble outgoing">${escapeHtml(text)}<span class="bubble-time">agora ✓✓</span></div>`).join('');
  content.innerHTML=heading('PRÉVIA','Veja como a conversa começa.','Simulação visual local; nenhuma mensagem é enviada pelo WhatsApp e nenhum modelo é chamado.')+
    `<div class="preview-layout"><div class="card"><h2>Simule a primeira mensagem</h2><p class="card-description">Marque se a mensagem recebida já informa a área. O bot usa textos configurados e não responde dúvidas jurídicas.</p>${usesExternal?'<div class="notice">Como Gemini está ativo, a primeira mensagem apenas informa o uso externo; essa mensagem não é processada pelo modelo.</div>':'<label class="checkboxline"><input id="preview-area" type="checkbox" '+(contactHasArea?'checked':'')+'> A primeira mensagem já informa o assunto</label>'}<div class="rule"></div><div class="field-grid">${numberInput('Máximo de balões por resposta','maxMessagesPerTurn',config.maxMessagesPerTurn,1,4)}${numberInput('Caracteres máximos por balão','maxCharsPerMessage',config.maxCharsPerMessage,80,4000)}</div><div class="notice green">Prévia de configuração. A extração usa apenas os campos deste fluxo; mensagens sem extração segura são esclarecidas ou encaminhadas.</div></div><div class="phone"><div class="phone-top"><div class="phone-avatar">${escapeHtml(config.officeName.slice(0,1).toUpperCase())}</div><div><div class="phone-name">${escapeHtml(config.officeName)}</div><div class="phone-status">triagem inicial</div></div></div><div class="bubble">Olá, gostaria de saber sobre o atendimento.<span class="bubble-time">agora</span></div>${bubbles||'<div class="empty">Ajuste a configuração para ver as mensagens.</div>'}</div></div>`;
  byId('preview-area').addEventListener('change',renderPreview);
}

async function renderContacts() {
  content.innerHTML=heading('OPERAÇÃO','Controle elegibilidade e estado.','Somente um contato elegível em estado BOT pode receber resposta. HUMANO e PAUSADO prevalecem; alterar a lista não inicia conversa.')+
    `<div class="grid two"><section class="card"><h2>Atribuir contato</h2><p class="card-description">Informe o número com DDI. Em Meta Cloud API, a lista interna deste painel é a fonte de verdade.</p><form id="contact-form" class="field-grid"><div class="control"><label>Telefone com DDI</label><input id="contact-phone" type="tel" placeholder="+55 11 99999-9999" required></div><div class="control"><label>Estado do atendimento</label><select id="contact-assignment"><option value="PAUSADO">Pausado / aguarda elegibilidade</option><option value="BOT">Elegível para triagem (BOT)</option><option value="HUMANO">Atendimento humano</option></select></div><button class="button primary" type="submit">Salvar estado</button></form></section><section class="card"><h2>Importar lista CSV</h2><p class="card-description">Colunas: telefone, atribuicao e nome. Valores: NOVO_LEAD, BOT ou HUMANO. Até 1.000 contatos.</p><div class="control"><label for="contact-file">Escolha o arquivo CSV (ou cole os dados abaixo)</label><input id="contact-file" type="file" accept=".csv,text/csv"></div><textarea id="contact-csv" rows="5" placeholder="telefone,atribuicao,nome&#10;+5511999999999,BOT,Ana Silva"></textarea><button class="button section-card" data-action="import-contacts">Importar contatos</button><div id="import-result"></div></section></div>`+
    `<section class="card section-card"><div class="card-title-row"><div><h2>Contatos acompanhados</h2><p class="card-description" style="margin:5px 0 0">A lista Atendimento tem prioridade se o contato também estiver em outra lista.</p></div><button class="button small" data-action="refresh-contacts">Atualizar</button></div><div id="contacts-table" class="table-wrap"><div class="empty-state">Carregando contatos...</div></div></section>`;
  const form=byId('contact-form');
  form?.addEventListener('submit',async(event)=>{event.preventDefault();const phone=byId('contact-phone').value;const assignment=byId('contact-assignment').value;try{await api('/api/contacts/assignment',{method:'PUT',body:JSON.stringify({phone,assignment})});toast('Atribuição atualizada.');void renderContacts();}catch(error){toast(error.message,true);}});
  byId('contact-file')?.addEventListener('change',async(event)=>{const file=event.target.files?.[0];if(file)byId('contact-csv').value=await file.text();});
  try {
    const contacts=await api('/api/contacts');
    const table=byId('contacts-table');
    table.innerHTML=contacts.length?`<table><thead><tr><th>Contato</th><th>Número</th><th>Primeiro contato observado</th><th>Elegibilidade</th><th>Estado</th><th>Última atividade</th></tr></thead><tbody>${contacts.map((contact)=>`<tr><td><strong>${escapeHtml(contact.displayName||'Contato')}</strong><small>${escapeHtml(contact.source)}${contact.manualPause?' · pausa manual':''}${contact.automationBlocked?' · bloqueio automático; reative pelo painel após revisão':''}</small></td><td>${escapeHtml(contact.phone)}</td><td>${contact.firstContactObserved?'Sim':'Ainda não'}</td><td>${escapeHtml(contact.eligibility)}</td><td><select data-contact-assignment data-jid="${escapeHtml(contact.jid)}"><option value="PAUSADO" ${contact.assignment==='PAUSADO'?'selected':''}>PAUSADO</option><option value="BOT" ${contact.assignment==='BOT'?'selected':''}>BOT</option><option value="HUMANO" ${contact.assignment==='HUMANO'?'selected':''}>HUMANO</option></select></td><td>${contact.lastActivityAt?new Date(contact.lastActivityAt).toLocaleString('pt-BR'):'—'}</td></tr>`).join('')}</tbody></table>`:'<div class="empty-state">Ainda não há contatos registrados.</div>';
    table.querySelectorAll('[data-contact-assignment]').forEach((el)=>el.addEventListener('change',()=>updateContact(el.dataset.jid,el.value)));
  } catch(error) { byId('contacts-table').innerHTML=`<div class="notice">Não foi possível carregar contatos: ${escapeHtml(error.message)}</div>`; }
}

async function renderDiagnostics() {
  content.innerHTML=heading('OPERAÇÃO','Entenda o que ocorreu com cada mensagem.','Acompanhe recebimento, fila, processamento, resposta, pausas e falhas com o motivo registrado.')+
    `<section class="card"><div class="card-title-row"><div><h2>Eventos recentes</h2><p class="card-description" style="margin:5px 0 0">Mensagens ignoradas mostram o motivo; falhas mostram o erro para orientar a correção.</p></div><button class="button small" data-action="refresh-diagnostics">Atualizar</button></div><div id="diagnostics-list" class="timeline"><div class="empty-state">Carregando eventos...</div></div></section>`;
  try {
    const events=await api('/api/diagnostics');
    const list=byId('diagnostics-list');
    list.innerHTML=events.length?events.map((event)=>`<article class="timeline-item"><span class="timeline-dot ${event.event.includes('falha')?'bad':event.event==='respondida'?'good':''}"></span><div class="timeline-copy"><strong>${escapeHtml(event.event.replaceAll('-',' '))}</strong><span>${escapeHtml(event.detail||'—')}</span><small>${escapeHtml(event.jid)} · ${new Date(event.createdAt).toLocaleString('pt-BR')}</small></div></article>`).join(''):'<div class="empty-state">Nenhum evento registrado ainda.</div>';
  } catch(error) { byId('diagnostics-list').innerHTML=`<div class="notice">Não foi possível carregar eventos: ${escapeHtml(error.message)}</div>`; }
}

async function updateContact(jid,assignment) {
  try { await api('/api/contacts/assignment',{method:'PUT',body:JSON.stringify({jid,assignment})});toast(`Contato atribuído a ${assignment}.`); }
  catch(error){toast(`A atribuição não foi sincronizada: ${error.message}`,true);void renderContacts();}
}

async function importContacts() {
  const csv=byId('contact-csv').value;
  try {
    const result=await api('/api/contacts/import',{method:'POST',body:JSON.stringify({csv})});
    const failed=result.results.filter((row)=>!row.ok);
    byId('import-result').innerHTML=failed.length?`<div class="error-summary import-errors"><strong>Falhas na importação</strong><ul>${failed.map((row)=>`<li><b>${escapeHtml(row.phone)}</b>: ${escapeHtml(row.error)}</li>`).join('')}</ul></div>`:'<div class="notice green">Todos os contatos foram importados e sincronizados.</div>';
    toast(`${result.imported} contato(s) importado(s).${failed.length?` ${failed.length} com erro; confira os diagnósticos.`:''}`,failed.length>0);
    void renderContacts();
  } catch(error){toast(error.message,true);}
}

function validateBeforeSave(show=true) {
  const issues=[];
  const requiredStrings=['officeName','assistantName','writingStyle','greeting','assistantNotice','privacyNotice','externalProviderNotice','areaQuestion','acknowledgementMessage','clarificationMessage','aiFallbackMessage','handoffMessage','audioRetryMessage','completionMessage','urgencyMessage','humanCommand','defaultProfileId','areaFieldId'];
  for(const path of requiredStrings){const value=path.split('.').reduce((target,key)=>target?.[key],config);if(typeof value!=='string'||!value.trim())issues.push({path,message:'Campo obrigatório vazio.',fix:'Preencha este campo antes de salvar.'});}
  if(!Array.isArray(config.profiles)||config.profiles.length===0)issues.push({path:'profiles',message:'Crie ao menos um fluxo.',fix:'Adicione uma área de atendimento.'});
  (config.profiles||[]).forEach((profile,profileIndex)=>{
    for(const key of ['id','label'])if(!String(profile[key]||'').trim())issues.push({path:`profiles.${profileIndex}.${key}`,message:'Campo obrigatório vazio.',fix:'Preencha este campo.'});
    if(!profile.fields?.length)issues.push({path:`profiles.${profileIndex}.fields`,message:'O fluxo precisa de uma pergunta.',fix:'Adicione ao menos uma pergunta.'});
    (profile.fields||[]).forEach((field,fieldIndex)=>{
      for(const key of ['id','label','question'])if(!String(field[key]||'').trim())issues.push({path:`profiles.${profileIndex}.fields.${fieldIndex}.${key}`,message:'Campo obrigatório vazio.',fix:'Preencha este campo.'});
      if(['single_choice','multiple_choice'].includes(field.type)&&!field.options?.length)issues.push({path:`profiles.${profileIndex}.fields.${fieldIndex}.options`,message:'Faltam opções de resposta.',fix:'Adicione pelo menos uma opção.'});
    });
    if(profile.fields?.length&&!profile.fields.some((field)=>field.id===config.areaFieldId&&field.required))issues.push({path:'areaFieldId',message:`O fluxo “${profile.label}” não possui o campo de área obrigatório.`,fix:'Inclua esse campo ou selecione uma área que exista em todos os fluxos.'});
  });
  (config.materials||[]).forEach((material,index)=>{
    for(const key of ['title','content'])if(!String(material[key]||'').trim())issues.push({path:`materials.${index}.${key}`,message:'Material incompleto.',fix:'Preencha o título e o conteúdo ou remova este material.'});
  });
  const numericRules={maxCharsPerMessage:[80,4000],maxMessagesPerTurn:[1,4],maxFieldAttempts:[1,5],maxAudioBytes:[1024,25000000],maxHistoryMessages:[1,50],workerPollMs:[100,10000],maxMessagesPerContactPerDay:[1,100000],maxMessagesPerContactPerMonth:[1,1000000],maxMessagesSentPerDay:[1,1000000],maxMessagesSentPerMonth:[1,10000000],retentionDays:[1,3650]};
  for(const [key,[minimum,maximum]] of Object.entries(numericRules)){const value=config[key];if(!Number.isFinite(value)||value<minimum||value>maximum)issues.push({path:key,message:'Valor numérico fora do intervalo permitido.',fix:`Informe um valor entre ${minimum} e ${maximum}.`});}
  for(const key of ['batchWindowSeconds','sendPartDelaySeconds','audioResponseDelaySeconds','audioTranscriptionTimeoutSeconds','typingSecondsPerCharacter','minSecondsBetweenContactMessages']){const value=config[key];if(!Number.isFinite(value)||value<(key==='audioTranscriptionTimeoutSeconds'?0.001:0)||value*1000>Number.MAX_SAFE_INTEGER)issues.push({path:key,message:'Duração inválida ou grande demais para medir.',fix:'Informe uma duração em segundos que o sistema consiga representar.'});}
  if((config.aiProvider==='gemini'||config.audioTranscriptionProvider==='gemini')&&String(config.externalProviderNotice||'').length>config.maxCharsPerMessage)issues.push({path:'externalProviderNotice',message:'O aviso do Gemini não cabe em um balão.',fix:'Reduza o aviso ou aumente o limite de caracteres por balão.'});
  document.querySelectorAll('.control.invalid').forEach((node)=>node.classList.remove('invalid'));
  const panel=byId('validation-errors');
  if(issues.length&&show){
    for(const issue of issues)markInvalid(issue.path);
    panel.classList.remove('hidden');
    panel.innerHTML=`<strong>Há informações para corrigir antes de salvar (${issues.length}).</strong><ul>${issues.slice(0,12).map((issue)=>`<li><button type="button" class="error-link" data-error-path="${escapeHtml(issue.path)}">${escapeHtml(describePath(issue.path)||'Configuração')}</button>: ${escapeHtml(issue.message)} ${escapeHtml(issue.fix)}</li>`).join('')}</ul>`;
    attachErrorLinks(panel);
  } else if(!issues.length){panel.classList.add('hidden');panel.innerHTML='';}
  return issues;
}

function markInvalid(path) {
  const escaped=CSS.escape(path);
  const field=content.querySelector(`[data-path="${escaped}"]`)||content.querySelector(`[data-list-path="${escaped}"]`);
  field?.closest('.control')?.classList.add('invalid');
}

function attachErrorLinks(panel) {
  panel.querySelectorAll('[data-error-path]').forEach((button)=>button.addEventListener('click',()=>{
    const path=button.dataset.errorPath||'';
    const parts=path.split('.');
    if(parts[0]==='profiles'){page='flow';profileIndex=Number(parts[1])||0;}
    else if(['materials','writingStyle','officeMemory','forbiddenTopics'].includes(parts[0]))page='knowledge';
    else if(['officeName','assistantName','greeting','assistantNotice','privacyNotice','externalProviderNotice','areaQuestion','areaFieldId','acknowledgementMessage','clarificationMessage','aiFallbackMessage','handoffMessage','audioRetryMessage','completionMessage','urgencyMessage'].includes(parts[0]))page='messages';
    else page='behavior';
    render();
    markInvalid(path);
    const field=content.querySelector(`[data-path="${CSS.escape(path)}"]`)||content.querySelector(`[data-list-path="${CSS.escape(path)}"]`);
    field?.scrollIntoView({behavior:'smooth',block:'center'});
  }));
}

function describePath(path) {
  const parts=(path||'').split('.');
  let label='Configuração';
  if(parts[0]==='profiles'&&Number.isInteger(Number(parts[1]))){
    const profile=config.profiles[Number(parts[1])];
    label=`Fluxos e perguntas → ${profile?.label||`Fluxo ${Number(parts[1])+1}`}`;
    if(parts[2]==='fields'&&Number.isInteger(Number(parts[3]))){const field=profile?.fields?.[Number(parts[3])];label+=` → ${field?.label||`Pergunta ${Number(parts[3])+1}`}`;parts.splice(0,4);}
    else parts.splice(0,2);
  }
  const titles={officeName:'Nome do escritório',assistantName:'Nome do assistente',writingStyle:'Estilo de escrita',greeting:'Mensagem de abertura',assistantNotice:'Aviso de assistente virtual',privacyNotice:'Aviso de privacidade',areaQuestion:'Pergunta sobre o assunto',areaFieldId:'Campo do assunto',acknowledgementMessage:'Confirmação fixa',clarificationMessage:'Pedido de esclarecimento',aiFallbackMessage:'Falha ou baixa confiança da IA',handoffMessage:'Mensagem de encaminhamento',audioRetryMessage:'Resposta para áudio',completionMessage:'Mensagem de conclusão',urgencyMessage:'Mensagem de urgência',humanCommand:'Comando para atendimento humano',legalQuestionKeywords:'Perguntas jurídicas a encaminhar',firstMessagePolicy:'Política da primeira mensagem',id:'Identificador',label:'Nome do campo',question:'Pergunta enviada',options:'Opções de resposta',materials:'Materiais de apoio',fields:'Perguntas do fluxo',askWhen:'Condição da pergunta',fieldId:'Pergunta da condição',title:'Título do material',content:'Conteúdo do material',defaultProfileId:'Área padrão'};
  const last=parts.at(-1)||'';
  return `${label}${label!=='Configuração'?' → ':''}${titles[last]||last.replaceAll(/[A-Z]/g,(letter)=>` ${letter.toLowerCase()}`)}`;
}

function action(name,indexValue) {
  const index=Number(indexValue);
  const profile=config.profiles[profileIndex];
  if(name==='goto-behavior'){page='behavior';render();return;}
  if(name==='refresh-whatsapp'){void refreshWhatsAppStatus();return;}
  if(name==='restart-whatsapp'){void restartWhatsApp();return;}
  if(name==='import-contacts'){void importContacts();return;}
  if(name==='import-materials'){void importMaterials();return;}
  if(name==='refresh-contacts'){void renderContacts();return;}
  if(name==='refresh-diagnostics'){void renderDiagnostics();return;}
  if(name==='add-profile') {const id=`fluxo-${Date.now().toString(36)}`;config.profiles.push({id,label:'Nova área',triggers:[],fields:[{id:config.areaFieldId,label:'Área ou assunto',question:'Em poucas palavras, qual é a área ou o assunto?',type:'open_text',options:[],structure:'',required:true}]});profileIndex=config.profiles.length-1;markDirty();renderFlow();return;}
  if(name==='remove-profile'){if(config.profiles.length<2){toast('Mantenha ao menos uma área de atendimento.');return;}config.profiles.splice(profileIndex,1);profileIndex=0;if(!config.profiles.some((item)=>item.id===config.defaultProfileId))config.defaultProfileId=config.profiles[0].id;markDirty();renderFlow();return;}
  if(name==='add-field'){profile.fields.push({id:`campo-${Date.now().toString(36)}`,label:'Nova pergunta',question:'',type:'open_text',options:[],structure:'',required:true});markDirty();renderFlow();return;}
  if(name==='remove-field'){profile.fields.splice(index,1);if(!profile.fields.length)profile.fields.push({id:`campo-${Date.now().toString(36)}`,label:'Pergunta inicial',question:'Qual é o assunto?',type:'open_text',options:[],structure:'',required:true});markDirty();renderFlow();return;}
  if(name==='up-field'&&index>0){[profile.fields[index-1],profile.fields[index]]=[profile.fields[index],profile.fields[index-1]];markDirty();renderFlow();return;}
  if(name==='down-field'&&index<profile.fields.length-1){[profile.fields[index+1],profile.fields[index]]=[profile.fields[index],profile.fields[index+1]];markDirty();renderFlow();return;}
  if(name==='add-material'){config.materials=config.materials||[];config.materials.push({title:'Novo material',content:''});markDirty();render();return;}
  if(name==='remove-material'){config.materials.splice(index,1);markDirty();render();}
}

async function restartWhatsApp() {
  const button=byId('whatsapp-restart');
  if(button)button.disabled=true;
  try{
    await api('/api/whatsapp/restart',{method:'POST',body:'{}'});
    toast('Solicitação de reinício enviada.');
    await refreshWhatsAppStatus();
  }catch(error){toast(error.message,true);}
  finally{if(button)button.disabled=false;}
}

async function importMaterials() {
  const input=byId('material-files');
  if(!input?.files?.length){toast('Selecione um ou mais arquivos primeiro.',true);return;}
  if(dirty){toast('Salve as alterações atuais antes de importar arquivos.',true);return;}
  const form=new FormData();
  for(const file of input.files)form.append('files',file,file.name);
  const button=content.querySelector('[data-action="import-materials"]');
  button.disabled=true;button.textContent='Lendo arquivos…';
  try{
    const result=await api('/api/materials/import',{method:'POST',body:form});
    config=await api('/api/config');
    page='knowledge';render();
    const report=byId('material-import-result');
    report.innerHTML=`<div class="${result.results.some((item)=>!item.ok)?'error-summary import-errors':'notice green'}"><strong>${result.imported} arquivo(s) de origem processado(s)</strong><ul>${result.results.map((item)=>`<li><b>${escapeHtml(item.file)}</b>: ${escapeHtml(item.detail)}</li>`).join('')}</ul></div>`;
    toast(`${result.imported} arquivo(s) importado(s).`,result.results.some((item)=>!item.ok));
  }catch(error){toast(error.message,true);}
  finally{const current=content.querySelector('[data-action="import-materials"]');if(current){current.disabled=false;current.textContent='Importar arquivos selecionados';}}
}

async function save() {
  if(validateBeforeSave().length)return;
  try {
    const normalized={...config,profiles:config.profiles.map((profile)=>({...profile,fields:profile.fields.map((field)=>{const copy={...field};if(!copy.askWhen?.fieldId||!copy.askWhen?.value)delete copy.askWhen;return copy;})}))};
    const result=await api('/api/config',{method:'PUT',body:JSON.stringify(normalized)});
    dirty=false;byId('save-state').textContent=`Salvo às ${new Date(result.savedAt).toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'})}`;byId('validation-errors').classList.add('hidden');toast('Configurações salvas e aplicadas.');
  } catch(error){
    if(error.details?.length){
      for(const issue of error.details)markInvalid(issue.path);
      byId('validation-errors').classList.remove('hidden');
      byId('validation-errors').innerHTML=`<strong>O servidor encontrou informações para corrigir.</strong><ul>${error.details.map((issue)=>`<li><button type="button" class="error-link" data-error-path="${escapeHtml(issue.path)}">${escapeHtml(describePath(issue.path))}</button>: ${escapeHtml(issue.message)} ${escapeHtml(issue.fix||'Revise este campo.')}</li>`).join('')}</ul>`;
      attachErrorLinks(byId('validation-errors'));
    } else {byId('validation-errors').classList.remove('hidden');byId('validation-errors').textContent=error.message;}
    toast('Veja a caixa de erro no início da página para localizar o problema.',true);
  }
}
function toast(message,isError=false){const el=byId('toast');el.textContent=message;el.style.background=isError?'#923f38':'#24332c';el.classList.add('show');setTimeout(()=>el.classList.remove('show'),3500);}
async function openApp(){config=await api('/api/config');login.classList.add('hidden');app.classList.remove('hidden');render();}

byId('login-form').addEventListener('submit',async(event)=>{event.preventDefault();byId('login-error').textContent='';try{await api('/api/login',{method:'POST',body:JSON.stringify({password:byId('password').value})});await openApp();}catch(error){byId('login-error').textContent=error.message;}});
byId('nav').addEventListener('click',(event)=>{const button=event.target.closest('[data-page]');if(!button)return;if(dirty&&!confirm('Você tem alterações não salvas. Trocar de tela e descartar?'))return;page=button.dataset.page;render();});
byId('save').addEventListener('click',save);
byId('logout').addEventListener('click',async()=>{await api('/api/logout',{method:'POST'});location.reload();});
byId('restore').addEventListener('click',async()=>{if(!confirm('Restaurar a última versão salva? As configurações atuais serão guardadas antes da restauração.'))return;try{await api('/api/restore-last',{method:'POST',body:'{}'});config=await api('/api/config');dirty=false;render();toast('Versão anterior restaurada.');}catch(error){toast(error.message,true);}});

(async()=>{try{const session=await api('/api/session');if(session.authenticated)await openApp();}catch{login.classList.remove('hidden');}})();
