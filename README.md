# WhatsApp Lead Qualification

Agente de atendimento inicial para WhatsApp, com painel visual, fluxos configuráveis, transcrição de áudios e encaminhamento para atendimento humano.

> Esta é uma base de MVP. Tanto Baileys quanto WAHA conectam pelo protocolo do WhatsApp Web e não são a API oficial da Meta. A conta pode ser desconectada ou restringida. Use um número de teste e avalie esse risco antes de conectar um número essencial do escritório.

## O que esta base faz

- Mantém Baileys como provedor legado e permite selecionar WAHA por variável de ambiente. Com WAHA, o app recebe webhooks autenticados e integra o envio de mensagens, áudio, listas/etiquetas e nome do contato.
- Persiste mensagens e tarefas em SQLite antes de processá-las.
- Agrupa mensagens seguidas durante uma janela configurável.
- Envia áudios PTT ao Gemini para transcrição em português e remove o arquivo temporário depois do processamento.
- Usa a API Gemini para extrair respostas estruturadas e escrever uma confirmação breve; diante de uma pergunta direta, responde primeiro com informação geral concisa quando houver base segura.
- Seleciona a próxima pergunta apenas a partir do fluxo configurado; o modelo não escolhe a pergunta, não analisa o caso individual nem recomenda medidas jurídicas.
- Pode enviar confirmação e pergunta em mensagens separadas, com intervalo configurável.
- Inclui painel web com senha, edição de fluxos e perguntas, instruções, materiais de apoio, prévia local e restauração da versão anterior.
- Organiza contatos pelas listas do WhatsApp `Novo Lead`, `Bot - atendimento` e `Atendimento`. Um lead em `Novo Lead` é movido para `Bot - atendimento`, que dispara a saudação e a primeira pergunta; somente essa lista pode ser atendida pelo agente. `Atendimento` prevalece em caso de conflito.
- Permite atribuir contatos pelo painel, importar uma lista CSV e consultar diagnósticos da fila.
- Permite marcar uma pergunta como nome do contato e salvar o nome informado na agenda do WhatsApp.
- Interrompe a automação em termos de urgência, comando de atendimento humano, falha repetida ou fim da triagem.
- Persiste mensagens e banco SQLite em `data/`; as credenciais Baileys ficam em `data/auth/` e o WAHA mantém a sessão em seu volume Docker próprio.

## Requisitos

- Node.js 22 ou superior.
- Um servidor Linux com armazenamento persistente para data/.
- Uma chave Gemini API. Modelos, cotas gratuitas e disponibilidade dependem do projeto Google AI Studio e podem mudar.

O áudio é enviado à API Gemini como entrada multimodal para transcrição e apagado localmente após o processamento. Confira as condições de dados e os limites atuais do seu projeto Google AI Studio antes de usar conversas reais.

## Configuração local

    npm install --allow-git=all
    Copy-Item .env.example .env
    Copy-Item config/qualification.example.json config/qualification.json

Preencha `GEMINI_API_KEY` em `.env`; opcionalmente, configure `GEMINI_MODEL` (padrão `gemini-3.5-flash`). Não coloque a chave no código, nos fluxos ou nos materiais. No primeiro início, o painel cria uma senha aleatória em `data/panel-password`; consulte esse arquivo localmente para entrar. Também é possível definir `PANEL_PASSWORD` no `.env`.

    npm run dev

Com `WHATSAPP_PROVIDER=baileys` (padrão), na primeira execução escaneie o QR exibido no terminal. A sessão Baileys autenticada é gravada em `data/auth/`. Para selecionar WAHA, use o Compose descrito abaixo; o QR da sessão WAHA aparece na tela **Conexão WhatsApp** do painel.

O painel usa `http://127.0.0.1:3000` por padrão e grava as mudanças no arquivo de configuração sem reiniciar o processo. Em uma VM, mantenha a porta do painel fechada para a internet e acesse por túnel SSH, por exemplo `ssh -L 3000:127.0.0.1:3000 usuario@IP_DA_VM`; depois abra `http://localhost:3000` no navegador. A senha gerada na primeira inicialização fica em `data/panel-password` (ou defina uma senha própria, com pelo menos 12 caracteres, em `PANEL_PASSWORD`). Para publicar um endereço web, configure um domínio e HTTPS com o exemplo `deploy/Caddyfile.example`, mantendo o painel ligado apenas em `127.0.0.1`; não exponha a porta 3000 diretamente na internet.

O painel permite configurar o estilo e limites de escrita, tópicos proibidos, memória institucional, materiais de texto, saudação, pergunta de área, cadência, simulação de digitação e limite de novos contatos. Em perguntas diretas, o Gemini pode explicar um conceito ou regra geral em uma ou duas frases, com base segura e sem aplicar a conclusão ao caso; não deve afirmar direitos individuais, prazos específicos, chances, resultados ou estratégias. A próxima pergunta de triagem continua sendo enviada pelo fluxo configurado, separadamente. Na área de materiais, importe vários arquivos de uma vez: PDF, TXT, Markdown, CSV, JSON e DOCX; ZIP é aberto e os formatos compatíveis internos são importados como materiais separados. O limite é de 20 materiais e 20.000 caracteres no total. PDFs somente imagem não têm texto extraído e exigem OCR. Os tempos ajustáveis são expressos em segundos. Cada fluxo admite perguntas abertas, sim/não, escolha única/múltipla, data e número, opções, orientação de estrutura e condições. A configuração ativa fica em `config/qualification.json`; cada gravação guarda uma cópia em `data/config-revisions`, mantendo as 20 versões mais recentes. Arquivos antigos com tempos em milissegundos são convertidos ao carregar, preservando a duração configurada.

### Usar WAHA pelo Docker Compose

O Compose é o caminho recomendado para uma VPS: inicia o agente e o WAHA, cria/configura a sessão `triagem`, registra o webhook autenticado e mantém o estado do WAHA em volume persistente. A imagem padrão é `devlikeapro/waha:gows`, com o mecanismo GOWS selecionado para suportar eventos de etiquetas e atualização de contatos. Para detalhes do WAHA, consulte a [configuração de sessões](https://waha.devlike.pro/docs/how-to/sessions/), [webhooks/eventos](https://waha.devlike.pro/docs/how-to/events/), [etiquetas](https://waha.devlike.pro/docs/how-to/labels/) e [contatos](https://waha.devlike.pro/docs/how-to/contacts/).

A documentação oficial atualmente anuncia a Community Edition como gratuita e oferece apoio opcional pago. Isso não cobre a VPS, armazenamento, tráfego nem eventuais custos/limites do projeto Google AI Studio; confirme os termos atuais antes de operar com dados reais.

No servidor, copie `.env.example` para `.env` e `config/qualification.example.json` para `config/qualification.json`. Configure `GEMINI_API_KEY` com uma chave do Google AI Studio e substitua `WAHA_API_KEY`, `WAHA_WEBHOOK_SECRET` e `WAHA_DASHBOARD_PASSWORD` por valores aleatórios únicos. Gere cada segredo separadamente com `openssl rand -hex 32`; não reutilize nem publique esses valores. O Compose escolhe WAHA mesmo que `WHATSAPP_PROVIDER` esteja como `baileys` no exemplo.

O container da aplicação roda como usuário sem privilégios, UID/GID `1000:1000`. Crie os diretórios persistidos e conceda acesso de escrita ao usuário do container antes de iniciar (ajuste UID/GID se sua imagem Node tiver valores diferentes):

    mkdir -p data config
    sudo chown -R 1000:1000 data config

Inicie e acompanhe os serviços:

    docker compose up -d --build
    docker compose logs -f app waha

As portas 3000 (painel) e 3001 (API/painel WAHA) são vinculadas somente a `127.0.0.1`. Acesse-as por túnel SSH, por exemplo `ssh -L 3000:127.0.0.1:3000 -L 3001:127.0.0.1:3001 usuario@IP_DA_VM`. Entre no painel do agente em `http://localhost:3000` usando a senha de `data/panel-password`, abra **Conexão WhatsApp** e leia o QR com **Aparelhos conectados → Conectar aparelho**. Opcionalmente, o painel do WAHA fica em `http://localhost:3001` e usa as credenciais configuradas no `.env`.

O arquivo `deploy/Caddyfile.example` pode encaminhar um domínio HTTPS ao painel do agente em `127.0.0.1:3000`; mantenha a API/painel do WAHA em loopback e não publique a porta 3001 na internet. `docker compose down` mantém o volume `waha_sessions`; **não use `docker compose down -v`** a menos que queira apagar a sessão e parear novamente. Faça backup seguro de `data/`, do volume `waha_sessions` e da configuração do escritório. A composição usa GOWS; confira a disponibilidade da imagem/mecanismo para a arquitetura do seu VPS antes da instalação.

Para executar WAHA fora do Compose, defina `WHATSAPP_PROVIDER=waha`, `WAHA_API_URL`, `WAHA_API_KEY`, `WAHA_SESSION`, `WAHA_WEBHOOK_URL` e `WAHA_WEBHOOK_SECRET`. O endereço do webhook precisa ser alcançável pelo container WAHA e apontar para `/api/waha/webhook` nesta aplicação; use HTTPS ao atravessar uma rede não confiável. A interface **Conexão WhatsApp** mostra o status e o QR sem expor a chave da API.

### Contatos, listas e importação

O WhatsApp passou a chamar suas etiquetas de listas em algumas versões e a disponibilidade depende da conta e do aplicativo. Crie as listas `Novo Lead`, `Bot - atendimento` e `Atendimento`. Quando um lead entra em `Novo Lead`, o agente o move para `Bot - atendimento` e inicia a conversa com a saudação e a pergunta configuradas. Também é possível mover um contato diretamente para `Bot - atendimento`; o worker colocará a abertura na fila. O agente só responde quando o banco local confirma essa lista. A lista `Atendimento` prevalece sobre `Bot - atendimento`; se nenhuma lista reconhecida estiver associada, o contato fica pausado. O painel sincroniza a atribuição com a sessão WhatsApp conectada e mantém uma cópia local para fila e diagnóstico.

Se aparecer `App state key not present!` ou `failed to find key ... to decode mutation`, a sessão vinculada perdeu uma chave de sincronização e não consegue atualizar listas. Pare o agente, faça uma cópia da pasta `data/auth` (ou do caminho configurado em `AUTH_DIR`), remova esse dispositivo em **Aparelhos conectados** no WhatsApp e renomeie a pasta de autenticação antiga para um backup. Reinicie o agente e leia o novo QR. Não apague o banco `data/agent.sqlite`; ele contém contatos, conversas e fila. O agente registra o erro e não marca a atribuição como Bot quando a sincronização falha.

Na página **Contatos e etiquetas**, altere a lista individual ou importe CSV com as colunas `telefone,atribuicao,nome`. `telefone` deve incluir DDI; use `NOVO_LEAD`, `BOT` ou `HUMANO` na coluna de atribuição. Exemplo:

    telefone,atribuicao,nome
    +5511999999999,BOT,Ana Silva

Na página **Fila e diagnósticos**, consulte eventos de entrada, processamento, resposta, pausa e falhas. Se o contato pedir uma pessoa ou houver uma sinalização de urgência, o atendimento é movido para a lista `Atendimento`.

## Configurar um fluxo

O arquivo config/qualification.example.json é um exemplo genérico, sem perguntas específicas de uma área do escritório. Cada perfil contém:

- triggers: expressões opcionais para selecionar o perfil;
- fields: campos ordenados, cada um com a pergunta que o agente deve fazer;
- required: se o campo bloqueia a conclusão da triagem;
- palavras de urgência globais;
- estilo de escrita, mensagens de encaminhamento e limites de envio.

Se nenhum gatilho corresponder, o perfil marcado como default é usado. O agente só pergunta o que estiver configurado. Campos ausentes após o limite de tentativas são sinalizados no resumo encaminhado à equipe.

## Variáveis

| Variável | Finalidade |
|---|---|
| GEMINI_API_KEY | Chave da API Gemini para texto e áudio |
| GEMINI_MODEL | Modelo Gemini; padrão `gemini-3.5-flash` |
| WHATSAPP_PROVIDER | `baileys` (padrão) ou `waha` |
| WAHA_API_URL | Endereço base da API WAHA; padrão local `http://localhost:3001` |
| WAHA_API_KEY | Chave enviada no cabeçalho `X-Api-Key` ao WAHA |
| WAHA_SESSION | Nome da sessão persistente; padrão `triagem` |
| WAHA_WEBHOOK_URL | URL alcançável pelo WAHA para `/api/waha/webhook` |
| WAHA_WEBHOOK_SECRET | Segredo enviado em `X-Waha-Webhook-Secret` e validado pelo painel |
| WAHA_IMAGE | Imagem Docker WAHA no Compose; padrão `devlikeapro/waha:gows` |
| WAHA_DASHBOARD_USERNAME | Usuário do painel web do WAHA; padrão `admin` |
| WAHA_DASHBOARD_PASSWORD | Senha do painel web do WAHA; obrigatória no Compose |
| DATABASE_PATH | Banco SQLite; padrão data/agent.sqlite |
| AUTH_DIR | Credenciais Baileys; padrão data/auth (não usado pelo provedor WAHA) |
| MEDIA_DIR | Áudios temporários; padrão data/tmp |
| CONFIG_PATH | Fluxos de qualificação; padrão config/qualification.json |
| HUMAN_NOTIFY_JID | JID opcional da equipe para receber o resumo da triagem |
| LOG_LEVEL | Nível de log do serviço |
| PANEL_HOST | Interface de rede do painel; padrão `127.0.0.1` (Compose usa `0.0.0.0` dentro da rede Docker) |
| PANEL_PORT | Porta do painel; padrão `3000` |
| PANEL_PASSWORD | Senha do painel; se vazia, uma senha aleatória é criada em `data/panel-password` |

## Persistência e filas

SQLite usa WAL e guarda mensagens, respostas estruturadas, tarefas de entrada e caixa de saída. Uma mensagem de entrada é gravada antes de entrar na fila. Tarefas pendentes e mensagens não processadas são recuperadas após uma reinicialização; o worker aplica uma espera curta configurável antes de consolidar mensagens da mesma conversa.

O áudio existe apenas em `data/tmp/` enquanto é transcrito; não faça backup dessa pasta. Faça backup protegido de `data/` (inclui SQLite, senha gerada do painel e, no caso do Baileys, credenciais da sessão) e do volume `waha_sessions` quando usar WAHA. Esses dados permitem controlar a sessão e conversas e devem ter acesso restrito.

## Implantação manual com Node.js

Copie o repositório para o VPS, instale Node.js 22+, configure `.env` e `config/qualification.json`, depois instale, compile e inicie:

    npm ci --allow-git=all
    npm run build
    npm start

O exemplo `deploy/whatsapp-lead.service` pode servir de base para systemd. Configure o caminho real do checkout, as permissões e um proxy TLS antes de instalar o serviço. Para WAHA, o Compose é recomendado, pois também configura a rede interna, persiste a sessão e mantém as portas públicas fechadas. Em qualquer provedor de VPS, confirme custos de computação, armazenamento, tráfego e endereço IP.

## Fontes de implementação

- [AgenticCRM](https://github.com/Sapheron/AgenticCRM): referência para Baileys, sessão persistente e reconexão; este MVP evita o conjunto completo de serviços do CRM.
- [SkipTheVoice](https://github.com/oliverjessner/SkipTheVoice): referência para SQLite e worker persistente de áudio.
- [WhatsApp AI Personal Assistant](https://github.com/basmaelsamati/WhatsApp-AI-Personal-Assistant): referência para o fluxo de detectar, transcrever e processar áudio; o exemplo usa Evolution API e n8n.
- [Lead Qualification Agent](https://github.com/Sufyanulhaq/lead-qualification-agent): referência para extração estruturada e regras visíveis; este projeto substitui as perguntas fixas por configuração JSON.
- [Outbound OS](https://github.com/thatsarpit/outbound-os): consultado para estados de conversa e interrupção de acompanhamentos. Ele usa a API oficial da Meta e licença AGPL-3.0, então não é dependência nem código incorporado aqui.
- [WAHA](https://github.com/devlikeapro/waha) e sua [documentação de engines](https://waha.devlike.pro/docs/how-to/engines/): integração REST/webhook opcional para sessão, eventos, mídia, etiquetas e atualização de contatos.

## Limitações atuais

- PDFs digitalizados sem camada de texto exigem OCR, que não está incluído.
- “Novo contato” significa contato sem histórico salvo pelo agente. O WhatsApp não informa a ele se o número era conhecido antes da instalação.
- A sincronização de listas depende da disponibilidade do recurso no WhatsApp e do engine selecionado no WAHA ou, no caso do Baileys, do estado de sincronização da sessão. A atribuição local é mantida no SQLite para fila e diagnóstico.
- O número e as perguntas ainda precisam ser configurados pelo escritório.
- A API gratuita não promete limite ou disponibilidade constantes.
- As explicações do agente são gerais e educativas, não aconselhamento jurídico individual. Ele faz triagem e encaminha; a análise e a orientação jurídica continuam com a equipe.
## Instalação

O npm 12 bloqueia por padrão dependências Git. Como o Baileys 6.7.24 fixa `libsignal` no GitHub, use:

    npm install --allow-git=all

Isso habilita dependências Git somente para esse comando, sem alterar a configuração global do npm. Se a instalação no Windows mostrar `EPERM` ao limpar `node_modules` dentro do OneDrive, feche processos Node/terminais que usem o projeto e, se persistir, clone o repositório fora da pasta sincronizada do OneDrive.
