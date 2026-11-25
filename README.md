# WhatsApp Lead Qualification

Agente de atendimento inicial para WhatsApp, com painel visual, fluxos configuráveis, transcrição de áudios e encaminhamento para atendimento humano.

> Esta é uma base de MVP. Baileys é uma integração não oficial e pode ser desconectada ou restringida pelo WhatsApp. Use um número de teste até validar o fluxo e aceite esse risco antes de conectar um número essencial do escritório.

## O que esta base faz

- Recebe mensagens privadas pelo evento messages.upsert do Baileys. Com esta integração, a entrada não é um webhook da API oficial.
- Persiste mensagens e tarefas em SQLite antes de processá-las.
- Agrupa mensagens seguidas durante uma janela configurável.
- Envia áudios PTT ao Gemini para transcrição em português e remove o arquivo temporário depois do processamento.
- Usa a API Gemini para extrair respostas estruturadas e escrever uma confirmação breve.
- Seleciona a próxima pergunta apenas a partir do fluxo configurado; o modelo não escolhe a pergunta nem fornece aconselhamento jurídico.
- Pode enviar confirmação e pergunta em mensagens separadas, com intervalo configurável.
- Inclui painel web com senha, edição de fluxos e perguntas, instruções, materiais de apoio, prévia local e restauração da versão anterior.
- Organiza contatos pelas listas do WhatsApp `Novo Lead`, `Bot - atendimento` e `Atendimento`. Um lead em `Novo Lead` é movido para `Bot - atendimento`, que dispara a saudação e a primeira pergunta; somente essa lista pode ser atendida pelo agente. `Atendimento` prevalece em caso de conflito.
- Permite atribuir contatos pelo painel, importar uma lista CSV e consultar diagnósticos da fila.
- Permite marcar uma pergunta como nome do contato e salvar o nome informado na agenda do WhatsApp.
- Interrompe a automação em termos de urgência, comando de atendimento humano, falha repetida ou fim da triagem.
- Guarda credenciais da sessão Baileys e banco local em data/, fora do repositório.

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

Na primeira execução, escaneie o QR exibido no terminal usando o WhatsApp do número de teste. A sessão autenticada é gravada em data/auth/.

O painel usa `http://127.0.0.1:3000` por padrão e grava as mudanças no arquivo de configuração sem reiniciar o processo. Em uma VM, mantenha a porta do painel fechada para a internet e acesse por túnel SSH, por exemplo `ssh -L 3000:127.0.0.1:3000 usuario@IP_DA_VM`; depois abra `http://localhost:3000` no navegador. A senha gerada na primeira inicialização fica em `data/panel-password` (ou defina uma senha própria, com pelo menos 12 caracteres, em `PANEL_PASSWORD`). Para publicar um endereço web, configure um domínio e HTTPS com o exemplo `deploy/Caddyfile.example`, mantendo o painel ligado apenas em `127.0.0.1`; não exponha a porta 3000 diretamente na internet.

O painel permite configurar o estilo e limites de escrita, tópicos proibidos, memória institucional, materiais de texto, saudação, pergunta de área, cadência, simulação de digitação e limite de novos contatos. Na área de materiais, importe vários arquivos de uma vez: PDF, TXT, Markdown, CSV, JSON e DOCX; ZIP é aberto e os formatos compatíveis internos são importados como materiais separados. O limite é de 20 materiais e 20.000 caracteres no total. PDFs somente imagem não têm texto extraído e exigem OCR. Os tempos ajustáveis são expressos em segundos. Cada fluxo admite perguntas abertas, sim/não, escolha única/múltipla, data e número, opções, orientação de estrutura e condições. A configuração ativa fica em `config/qualification.json`; cada gravação guarda uma cópia em `data/config-revisions`, mantendo as 20 versões mais recentes. Arquivos antigos com tempos em milissegundos são convertidos ao carregar, preservando a duração configurada.

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
| DATABASE_PATH | Banco SQLite; padrão data/agent.sqlite |
| AUTH_DIR | Credenciais Baileys; padrão data/auth |
| MEDIA_DIR | Áudios temporários; padrão data/tmp |
| CONFIG_PATH | Fluxos de qualificação; padrão config/qualification.json |
| HUMAN_NOTIFY_JID | JID opcional da equipe para receber o resumo da triagem |
| LOG_LEVEL | Nível de log do serviço |
| PANEL_HOST | Interface de rede do painel; padrão `127.0.0.1` |
| PANEL_PORT | Porta do painel; padrão `3000` |
| PANEL_PASSWORD | Senha do painel; se vazia, uma senha aleatória é criada em `data/panel-password` |

## Persistência e filas

SQLite usa WAL e guarda mensagens, respostas estruturadas, tarefas de entrada e caixa de saída. Uma mensagem de entrada é gravada antes de entrar na fila. Tarefas pendentes e mensagens não processadas são recuperadas após uma reinicialização; o worker aplica uma espera curta configurável antes de consolidar mensagens da mesma conversa.

O áudio existe apenas em data/tmp/ enquanto é transcrito. Não faça backup dessa pasta. Faça backup protegido de data/agent.sqlite e data/auth/; a pasta de autenticação permite controlar a sessão WhatsApp e deve ter acesso restrito.

## Implantação em EC2

Copie o repositório para o servidor, instale Node.js 22+, execute `npm ci --allow-git=all`, configure `.env` e `config/qualification.json`, depois compile e inicie:

    npm run build
    npm start

Para manter o processo após fechar o SSH, use o serviço de exemplo em deploy/whatsapp-lead.service como base para systemd. Configure o caminho real do checkout antes de instalar o serviço. Mantenha a aplicação e o armazenamento dentro das cotas gratuitas publicadas no seu projeto AWS; armazenamento, tráfego, IPv4 público e outros recursos podem gerar custos fora da cota.

## Fontes de implementação

- [AgenticCRM](https://github.com/Sapheron/AgenticCRM): referência para Baileys, sessão persistente e reconexão; este MVP evita o conjunto completo de serviços do CRM.
- [SkipTheVoice](https://github.com/oliverjessner/SkipTheVoice): referência para SQLite e worker persistente de áudio.
- [WhatsApp AI Personal Assistant](https://github.com/basmaelsamati/WhatsApp-AI-Personal-Assistant): referência para o fluxo de detectar, transcrever e processar áudio; o exemplo usa Evolution API e n8n.
- [Lead Qualification Agent](https://github.com/Sufyanulhaq/lead-qualification-agent): referência para extração estruturada e regras visíveis; este projeto substitui as perguntas fixas por configuração JSON.
- [Outbound OS](https://github.com/thatsarpit/outbound-os): consultado para estados de conversa e interrupção de acompanhamentos. Ele usa a API oficial da Meta e licença AGPL-3.0, então não é dependência nem código incorporado aqui.

## Limitações atuais

- PDFs digitalizados sem camada de texto exigem OCR, que não está incluído.
- “Novo contato” significa contato sem histórico salvo pelo agente. O WhatsApp não informa a ele se o número era conhecido antes da instalação.
- A sincronização de listas depende do WhatsApp Business, da disponibilidade do recurso na conta e do comportamento do protocolo não oficial do Baileys. O painel mantém a atribuição local como registro de segurança.
- O número e as perguntas ainda precisam ser configurados pelo escritório.
- A API gratuita não promete limite ou disponibilidade constantes.
- Nenhum código deste repositório deve ser considerado aconselhamento jurídico automático. O agente faz triagem e encaminha; a análise e a orientação jurídica continuam com a equipe.
## Instalação

O npm 12 bloqueia por padrão dependências Git. Como o Baileys 6.7.24 fixa `libsignal` no GitHub, use:

    npm install --allow-git=all

Isso habilita dependências Git somente para esse comando, sem alterar a configuração global do npm. Se a instalação no Windows mostrar `EPERM` ao limpar `node_modules` dentro do OneDrive, feche processos Node/terminais que usem o projeto e, se persistir, clone o repositório fora da pasta sincronizada do OneDrive.

