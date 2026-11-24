const byId = (id) => document.getElementById(id);
const app = byId('app');
const login = byId('login');
const content = byId('content');
const TITLES = { overview:'Visão geral', behavior:'Comportamento', flow:'Fluxos e perguntas', messages:'Mensagens', knowledge:'Instruções e materiais', preview:'Testar conversa' };
let config = null;
let page = 'overview';
let profileIndex = 0;
let dirty = false;

async function api(path, options = {}) {
  const response = await fetch(path, { credentials:'same-origin', ...options, headers:{ ...(options.body ? {'Content-Type':'application/json'} : {}), ...(options.headers || {}) } });
  const payload = response.status === 204 ? {} : await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Falha na solicitação (${response.status}).`);
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
function numberInput(label, path, value, min, max, help='') { return input(label,path,value,{attrs:`type="number" min="${min}" max="${max}"`,help}); }
function textarea(label,path,value,help='',rows=4) { return `<div class="control full-width"><label>${escapeHtml(label)}</label><textarea data-path="${path}" rows="${rows}">${escapeHtml(value)}</textarea>${help?`<small>${escapeHtml(help)}</small>`:''}</div>`; }
function select(label,path,value,options,help='') { return `<div class="control"><label>${escapeHtml(label)}</label><select data-path="${path}">${options.map(([v,l])=>`<option value="${escapeHtml(v)}" ${v===value?'selected':''}>${escapeHtml(l)}</option>`).join('')}</select>${help?`<small>${escapeHtml(help)}</small>`:''}</div>`; }
function toggle(label,path,checked,help='') { return `<div class="toggle-row"><div class="toggle-copy"><strong>${escapeHtml(label)}</strong><small>${escapeHtml(help)}</small></div><label class="switch"><input type="checkbox" data-path="${path}" ${checked?'checked':''}><span></span></label></div>`; }
function heading(kicker,title,description,action='') { return `<div class="page-heading"><div><p class="eyebrow">${escapeHtml(kicker)}</p><h1>${escapeHtml(title)}</h1><p>${escapeHtml(description)}</p></div>${action}</div>`; }
function markDirty() { dirty=true; byId('save-state').textContent='Alterações não salvas'; }
function setPath(path,value) { const parts=path.split('.'); let target=config; for(const part of parts.slice(0,-1)){if(target[part]===undefined||target[part]===null)target[part]={};target=target[part];} target[parts.at(-1)]=value; markDirty(); }

function render() {
  byId('page-title').textContent = TITLES[page];
  document.querySelectorAll('.nav-item').forEach((item)=>item.classList.toggle('active',item.dataset.page===page));
  if(page==='overview') renderOverview();
  if(page==='behavior') renderBehavior();
  if(page==='flow') renderFlow();
  if(page==='messages') renderMessages();
  if(page==='knowledge') renderKnowledge();
  if(page==='preview') renderPreview();
  content.querySelectorAll('[data-path]').forEach((el)=>{
    const eventName=['checkbox','number','select-one','radio'].includes(el.type)?'change':'input';
    el.addEventListener(eventName,()=>{
      const value=el.type==='checkbox'?el.checked:el.type==='number'?Number(el.value):el.value;
      setPath(el.dataset.path,value);
      if(el.dataset.path.endsWith('.type')) renderFlow();
      if(el.dataset.path==='areaFieldId') renderMessages();
      if(page==='preview') renderPreview();
    });
  });
  content.querySelectorAll('[data-list-path]').forEach((el)=>el.addEventListener('input',()=>{setPath(el.dataset.listPath,parseList(el.value));}));
  content.querySelectorAll('[data-action]').forEach((el)=>el.addEventListener('click',()=>action(el.dataset.action,el.dataset.index)));
}

function renderOverview() {
  const profile=config.profiles.find((item)=>item.id===config.defaultProfileId) || config.profiles[0];
  content.innerHTML=heading('SEU ATENDIMENTO','Uma recepção clara, do primeiro oi ao encaminhamento.','Configure o jeito de conversar, as perguntas e os limites do agente. As mudanças são aplicadas sem reiniciar o serviço.')+
    `<div class="grid three"><div class="card stat-card"><div class="stat-label">ÁREA DE ATENDIMENTO</div><div class="stat-value">${escapeHtml(profile.label)}</div><div class="stat-note">Fluxo padrão selecionado</div></div><div class="card stat-card"><div class="stat-label">PERGUNTAS CONFIGURADAS</div><div class="stat-value">${profile.fields.length}</div><div class="stat-note">Em ${config.profiles.length} fluxo(s)</div></div><div class="card stat-card"><div class="stat-label">MENSAGENS POR VEZ</div><div class="stat-value">Até ${config.maxMessagesPerTurn}</div><div class="stat-note">Com pausa entre os balões</div></div></div>`+
    `<div class="grid two section-card"><div class="card"><div class="card-title-row"><h2>Ritmo do atendimento</h2><span class="pill">WhatsApp</span></div><p class="card-description">Ajuste como o agente recebe e envia mensagens.</p>${toggle('Responder somente novos contatos','newContactsOnly',config.newContactsOnly,'O agente inicia triagens apenas em contatos que ainda não têm histórico salvo por ele. Conversas já iniciadas continuam normalmente.')}${toggle('Simular “escrevendo…”','simulateTyping',config.simulateTyping,'Mostra presença de digitação antes de enviar cada balão.')}</div><div class="card"><div class="card-title-row"><h2>Proteção do atendimento</h2><span class="pill">Controle do escritório</span></div><p class="card-description">O agente organiza informações iniciais e encaminha para a equipe.</p><div class="notice green">As instruções do painel servem para orientar a triagem. O agente não substitui a análise jurídica da equipe e encaminha sinais de urgência.</div><button class="button section-card" data-action="goto-behavior">Revisar comportamento →</button></div></div>`;
}

function renderBehavior() {
  content.innerHTML=heading('COMPORTAMENTO','Defina o ritmo e os limites.','Ajuste a espera, a simulação de digitação, o tamanho das mensagens e a quem o agente responde.')+
    `<div class="grid two"><div class="card"><h2>Quem recebe resposta</h2><p class="card-description">Controle quando uma conversa pode começar automaticamente.</p>${toggle('Responder apenas novos contatos','newContactsOnly',config.newContactsOnly,'“Novo” significa que este agente ainda não registrou mensagens daquele número. O WhatsApp não informa por Baileys se o número já era conhecido antes da instalação.')}</div><div class="card"><h2>Simulação humana</h2><p class="card-description">Ajuste a presença e a pausa entre respostas.</p>${toggle('Mostrar “escrevendo…”','simulateTyping',config.simulateTyping,'Durante a espera, o contato verá a presença de digitação do WhatsApp.')}${numberInput('Velocidade simulada (ms por caractere)','typingMsPerCharacter',config.typingMsPerCharacter,0,100,'A espera é limitada a 12 segundos por balão.')}</div></div>`+
    `<div class="card section-card"><h2>Cadência e tamanho</h2><p class="card-description">A janela de agrupamento permite que o agente espere mensagens enviadas em sequência antes de responder.</p><div class="field-grid">${numberInput('Esperar para agrupar mensagens (ms)','batchWindowMs',config.batchWindowMs,0,60000)}${numberInput('Pausa entre balões (ms)','sendPartDelayMs',config.sendPartDelayMs,0,10000)}${numberInput('Máximo de balões por resposta','maxMessagesPerTurn',config.maxMessagesPerTurn,1,4)}${numberInput('Caracteres máximos na confirmação','maxCharsPerMessage',config.maxCharsPerMessage,80,4000,'Limita a frase de confirmação criada pelo modelo; perguntas configuradas são mantidas como escritas.')}${numberInput('Tentativas antes de pular uma pergunta','maxFieldAttempts',config.maxFieldAttempts,1,5,'Se a resposta não for compreendida após essas tentativas, a triagem segue e sinaliza o campo à equipe.')}${textarea('Palavras ou expressões de urgência (uma por linha)','handoffKeywords',newlineList(config.handoffKeywords),'Ao encontrar uma delas, o agente interrompe as perguntas e encaminha o atendimento.',4)}${input('Comando para pedir uma pessoa','humanCommand',config.humanCommand,{help:'O contato pode enviar este comando para pausar a automação e solicitar atendimento humano.'})}</div><div class="notice">O modo “somente novos contatos” usa o histórico que o agente passa a registrar. Contatos antigos que nunca escreveram ao número depois da instalação podem parecer novos ao agente.</div></div>`;
  const urgent = content.querySelector('[data-path="handoffKeywords"]'); if(urgent){urgent.dataset.listPath='handoffKeywords';urgent.removeAttribute('data-path');}
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
  return `<div class="question-card"><div class="question-head"><span class="question-number">${String(index+1).padStart(2,'0')}</span><strong>${escapeHtml(field.label||'Nova pergunta')}</strong><button class="button small" data-action="up-field" data-index="${index}" ${index===0?'disabled':''}>↑</button><button class="button small" data-action="down-field" data-index="${index}" ${index===profile.fields.length-1?'disabled':''}>↓</button><button class="button small danger" data-action="remove-field" data-index="${index}">Remover</button></div><div class="field-grid">${input('Identificador único',base+'.id',field.id)}${input('Nome do campo',base+'.label',field.label)}${textarea('Pergunta enviada ao contato',base+'.question',field.question,'A pergunta exibida quando este campo for o próximo.',2)}${select('Tipo de resposta',base+'.type',field.type,typeOptions)}${textarea('Estrutura ou orientação para interpretar a resposta',base+'.structure',field.structure||'','Ex.: peça data aproximada e cidade; aceite que a pessoa não saiba.',2)}${choices}${condition}${conditionValue}<div class="control"><label>Obrigatoriedade</label><label class="checkboxline"><input type="checkbox" data-path="${base}.required" ${field.required?'checked':''}> Campo necessário para concluir a triagem</label></div></div></div>`;
}

function renderMessages() {
  const profile=config.profiles.find((item)=>item.id===config.defaultProfileId)||config.profiles[0];
  const fields=profile.fields.map((field)=>[field.id,field.label]);
  content.innerHTML=heading('MENSAGENS','A primeira impressão importa.','Configure a saudação, a pergunta de área e as respostas de encaminhamento. Veja o resultado em uma prévia.')+
    `<div class="grid two"><div class="card"><h2>Identidade e abertura</h2><p class="card-description">O agente envia a saudação e, se ainda não identificar o assunto, pergunta a área de atuação.</p><div class="field-grid">${input('Nome do escritório','officeName',config.officeName)}${input('Nome do assistente','assistantName',config.assistantName)}${textarea('Mensagem de saudação','greeting',config.greeting,'Enviada no início do primeiro atendimento.',3)}${textarea('Pergunta sobre a área de atuação','areaQuestion',config.areaQuestion,'Enviada somente quando a mensagem inicial ainda não informa o assunto.',3)}${select('Campo que guarda a área','areaFieldId',config.areaFieldId,fields,'A resposta fica salva neste campo nos fluxos.')}</div></div><div class="card"><h2>Encaminhamentos</h2><p class="card-description">Mensagens usadas quando o agente precisa parar ou concluir.</p><div class="field-grid">${textarea('Solicitação de atendimento humano','handoffMessage',config.handoffMessage,'',3)}${textarea('Sinal de urgência','urgencyMessage',config.urgencyMessage,'',3)}${textarea('Triagem concluída','completionMessage',config.completionMessage,'',3)}${textarea('Áudio não compreendido','audioRetryMessage',config.audioRetryMessage,'',3)}</div></div></div>`;
}

function renderKnowledge() {
  const materials=(config.materials||[]).map((material,index)=>`<div class="material-card"><div class="material-head"><div class="control"><label>Título do material</label><input data-path="materials.${index}.title" value="${escapeHtml(material.title)}"></div><button class="button small danger" data-action="remove-material" data-index="${index}">Remover</button></div><div class="control"><label>Conteúdo de apoio</label><textarea rows="5" data-path="materials.${index}.content">${escapeHtml(material.content)}</textarea><small>Use informações aprovadas pelo escritório. Evite dados de clientes e documentos de casos reais.</small></div></div>`).join('');
  content.innerHTML=heading('ORIENTAÇÕES DO ESCRITÓRIO','Dê contexto. Preserve os limites.','Instruções e materiais são enviados ao modelo como contexto para extrair informações e escrever uma confirmação breve.')+
    `<div class="grid two"><div class="card"><h2>Tom e estilo</h2><p class="card-description">Explique como o agente deve escrever.</p>${textarea('Estilo de escrita','writingStyle',config.writingStyle,'Ex.: linguagem simples, acolhedora, frases curtas; não dar orientação jurídica.',7)}<div class="rule"></div>${textarea('O que o agente não deve abordar','forbiddenTopics',newlineList(config.forbiddenTopics),'Um tema ou limite por linha. Isso orienta o modelo, mas não substitui revisão humana.',5)}</div><div class="card"><h2>Memória institucional</h2><p class="card-description">Informações gerais estáveis sobre o escritório que ajudam a contextualizar a conversa.</p>${textarea('Informações e contexto do escritório','officeMemory',config.officeMemory||'','Não inclua informações confidenciais ou dados de clientes.',8)}<div class="notice">As respostas do contato são mantidas no banco local para continuidade e encaminhamento. Esta área é a memória geral do escritório, compartilhada entre conversas.</div></div></div>`+
    `<div class="card section-card"><div class="card-title-row"><div><h2>Materiais de apoio</h2><p class="card-description" style="margin:5px 0 0">Cole trechos curtos, perguntas frequentes e informações institucionais revisadas.</p></div><button class="button small" data-action="add-material">＋ Adicionar material</button></div>${materials||'<div class="empty-state">Nenhum material adicionado.</div>'}<div class="notice">Os materiais são enviados ao provedor do modelo junto com o contexto da triagem. Não use documentos com dados pessoais de clientes.</div></div>`;
  const doNotSay=content.querySelector('[data-path="forbiddenTopics"]'); if(doNotSay){doNotSay.dataset.listPath='forbiddenTopics';doNotSay.removeAttribute('data-path');}
}

function renderPreview() {
  const profile=config.profiles.find((item)=>item.id===config.defaultProfileId)||config.profiles[0];
  const firstQuestion=config.areaQuestion||profile.fields[0]?.question||'Qual é o assunto?';
  const contactHasArea=byId('preview-area')?.checked||false;
  const messages=[config.greeting,contactHasArea?(profile.fields.find((field)=>field.id!==config.areaFieldId)?.question||'Como posso ajudar?'):firstQuestion];
  const opening=messages.length<=config.maxMessagesPerTurn?messages:[...messages.slice(0,config.maxMessagesPerTurn-1),messages.slice(config.maxMessagesPerTurn-1).join('\n\n')];
  const bubbles=opening.map((text)=>`<div class="bubble outgoing">${escapeHtml(text)}<span class="bubble-time">agora ✓✓</span></div>`).join('');
  content.innerHTML=heading('PRÉVIA','Veja como a conversa começa.','Simulação visual local; nenhuma mensagem é enviada pelo WhatsApp e nenhum modelo é chamado.')+
    `<div class="preview-layout"><div class="card"><h2>Simule a primeira mensagem</h2><p class="card-description">Marque se a mensagem inicial já informa a área de atuação. A prévia mostra qual pergunta vem depois da saudação.</p><label class="checkboxline"><input id="preview-area" type="checkbox" ${contactHasArea?'checked':''}> A primeira mensagem já informa o assunto</label><div class="rule"></div><div class="field-grid">${numberInput('Máximo de balões por resposta','maxMessagesPerTurn',config.maxMessagesPerTurn,1,4)}${numberInput('Caracteres máximos na confirmação','maxCharsPerMessage',config.maxCharsPerMessage,80,4000)}</div><div class="notice green">Prévia de configuração. A identificação da área depende das informações expressas pelo contato e da extração do modelo.</div></div><div class="phone"><div class="phone-top"><div class="phone-avatar">${escapeHtml(config.officeName.slice(0,1).toUpperCase())}</div><div><div class="phone-name">${escapeHtml(config.officeName)}</div><div class="phone-status">atendimento inicial</div></div></div><div class="bubble">Olá, gostaria de saber sobre o atendimento.<span class="bubble-time">agora</span></div>${bubbles||'<div class="empty">Ajuste a configuração para ver as mensagens.</div>'}</div></div>`;
  byId('preview-area').addEventListener('change',renderPreview);
}

function action(name,indexValue) {
  const index=Number(indexValue);
  const profile=config.profiles[profileIndex];
  if(name==='goto-behavior'){page='behavior';render();return;}
  if(name==='add-profile') {const id=`fluxo-${Date.now().toString(36)}`;config.profiles.push({id,label:'Nova área',triggers:[],fields:[{id:config.areaFieldId,label:'Área ou assunto',question:'Em poucas palavras, qual é a área ou o assunto?',type:'open_text',options:[],structure:'',required:true}]});profileIndex=config.profiles.length-1;markDirty();renderFlow();return;}
  if(name==='remove-profile'){if(config.profiles.length<2){toast('Mantenha ao menos uma área de atendimento.');return;}config.profiles.splice(profileIndex,1);profileIndex=0;if(!config.profiles.some((item)=>item.id===config.defaultProfileId))config.defaultProfileId=config.profiles[0].id;markDirty();renderFlow();return;}
  if(name==='add-field'){profile.fields.push({id:`campo-${Date.now().toString(36)}`,label:'Nova pergunta',question:'',type:'open_text',options:[],structure:'',required:true});markDirty();renderFlow();return;}
  if(name==='remove-field'){profile.fields.splice(index,1);if(!profile.fields.length)profile.fields.push({id:`campo-${Date.now().toString(36)}`,label:'Pergunta inicial',question:'Qual é o assunto?',type:'open_text',options:[],structure:'',required:true});markDirty();renderFlow();return;}
  if(name==='up-field'&&index>0){[profile.fields[index-1],profile.fields[index]]=[profile.fields[index],profile.fields[index-1]];markDirty();renderFlow();return;}
  if(name==='down-field'&&index<profile.fields.length-1){[profile.fields[index+1],profile.fields[index]]=[profile.fields[index],profile.fields[index+1]];markDirty();renderFlow();return;}
  if(name==='add-material'){config.materials=config.materials||[];config.materials.push({title:'Novo material',content:''});markDirty();renderKnowledge();return;}
  if(name==='remove-material'){config.materials.splice(index,1);markDirty();renderKnowledge();}
}

async function save() {
  try {
    const normalized={...config,profiles:config.profiles.map((profile)=>({...profile,fields:profile.fields.map((field)=>{const copy={...field};if(!copy.askWhen?.fieldId||!copy.askWhen?.value)delete copy.askWhen;return copy;})}))};
    const result=await api('/api/config',{method:'PUT',body:JSON.stringify(normalized)});
    dirty=false;byId('save-state').textContent=`Salvo às ${new Date(result.savedAt).toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'})}`;toast('Configurações salvas e aplicadas.');
  } catch(error){toast(error.message,true);}
}
function toast(message,isError=false){const el=byId('toast');el.textContent=message;el.style.background=isError?'#923f38':'#24332c';el.classList.add('show');setTimeout(()=>el.classList.remove('show'),3500);}
async function openApp(){config=await api('/api/config');login.classList.add('hidden');app.classList.remove('hidden');render();}

byId('login-form').addEventListener('submit',async(event)=>{event.preventDefault();byId('login-error').textContent='';try{await api('/api/login',{method:'POST',body:JSON.stringify({password:byId('password').value})});await openApp();}catch(error){byId('login-error').textContent=error.message;}});
byId('nav').addEventListener('click',(event)=>{const button=event.target.closest('[data-page]');if(!button)return;if(dirty&&!confirm('Você tem alterações não salvas. Trocar de tela e descartar?'))return;page=button.dataset.page;render();});
byId('save').addEventListener('click',save);
byId('logout').addEventListener('click',async()=>{await api('/api/logout',{method:'POST'});location.reload();});
byId('restore').addEventListener('click',async()=>{if(!confirm('Restaurar a última versão salva? As configurações atuais serão guardadas antes da restauração.'))return;try{await api('/api/restore-last',{method:'POST',body:'{}'});config=await api('/api/config');dirty=false;render();toast('Versão anterior restaurada.');}catch(error){toast(error.message,true);}});

(async()=>{try{const session=await api('/api/session');if(session.authenticated)await openApp();}catch{login.classList.remove('hidden');}})();
