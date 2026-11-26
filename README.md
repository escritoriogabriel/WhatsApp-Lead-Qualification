# WhatsApp Lead Qualification

Aplicação local-first para acolhimento e triagem inicial de leads de um escritório de advocacia. O bot coleta somente os campos configurados, usa mensagens fixas e encaminha dúvidas jurídicas individuais, urgências, baixa confiança e pedidos de atendimento humano à equipe.

O modelo de IA **não redige mensagens ao contato**, não escolhe quem pode receber resposta, não decide urgência, não encerra atendimento e não avalia direitos, documentos ou provas. Nenhuma automação inicia conversa sem uma mensagem recebida.

## Estado do projeto

Esta versão inclui os adaptadores Meta Cloud API, WAHA e Baileys, uma fila persistente, controles de autorização, retenção configurável e testes com mocks. Ela ainda exige configuração, revisão jurídica e teste em ambiente controlado antes de qualquer uso com dados reais. Não oferece garantia de envio único ou disponibilidade contínua.

## Como funciona a triagem

1. A mensagem recebida é deduplicada pelo identificador do provedor, gravada no SQLite e colocada na fila antes da confirmação do webhook.
2. O primeiro contato observado pelo programa fica registrado como tal; isso não afirma que a pessoa nunca falou com o escritório antes.
3. O escritório escolhe no painel se a primeira mensagem recebida inicia a triagem ou se o contato aguarda inclusão explícita na lista elegível.
4. A resposta só é liberada se a elegibilidade, a atribuição `BOT`, a ausência de pausa e a sincronização exigida pelo provedor estiverem confirmadas. `HUMANO`, pausa manual e bloqueio automático impedem envios.
5. As respostas são montadas com textos fixos e perguntas do perfil. A divisão em balões é determinística, respeita limites, aguarda o intervalo configurado e verifica a autorização novamente antes do envio.
6. Falha de autorização mantém mensagens recebidas pendentes. Falha de envio com resultado incerto bloqueia o contato para revisão; o sistema não repete esse envio automaticamente.

Se a configuração usar Gemini, o primeiro conteúdo da conversa **não é enviado ao modelo**. O bot envia primeiro o aviso externo configurado e só considera mensagens recebidas depois desse aviso. A mensagem inicial fica fora da extração externa. Se o aviso não for confirmado pelo provedor, a triagem externa não continua.

## Provedores de WhatsApp

| Provedor | Uso previsto | Autorização | Limitações relevantes |
|---|---|---|---|
| **Meta Cloud API** | Opção oficial para produção | Lista interna do painel | Exige conta Business, token, ID do número, assinatura de webhook e endpoint público HTTPS. O adaptador envia texto livre e não oferece templates, verificação de saúde da API nem confirmação de entrega. O status “Configurado” significa que as credenciais foram carregadas, não que a conta foi testada. |
| **WAHA / GOWS** | Teste e operação local | Etiquetas/listas do WhatsApp, conferidas antes de cada envio | Usa sessão do WhatsApp Web. Não oferece a mesma garantia operacional da API oficial. Eventos e APIs de etiquetas são documentados pelo [WAHA](https://waha.devlike.pro/docs/how-to/labels/), [eventos](https://waha.devlike.pro/docs/how-to/events/) e [mecanismos](https://waha.devlike.pro/docs/how-to/engines/). |
| **Baileys** | Compatibilidade legada | Etiquetas sincronizadas pela sessão | Também usa o protocolo do WhatsApp Web e depende da sincronização da sessão. Não é a integração indicada para produção. |

A aplicação não inclui campanhas, modelos aprovados, acompanhamento de status de entrega ou automação para contornar limites do provedor. Consulte a documentação oficial da [WhatsApp Business Platform](https://developers.facebook.com/documentation/business-messaging/whatsapp/overview), dos [webhooks de WhatsApp](https://developers.facebook.com/docs/graph-api/webhooks/getting-started/webhooks-for-whatsapp/) e das [regras de preços](https://developers.facebook.com/docs/whatsapp/pricing/) antes de estimar custos ou ativar a API.

O seletor de provedor fica na página **Conexão WhatsApp**. A seleção e as configurações do assistente são salvas no arquivo JSON com gravação atômica e até 20 revisões. Os segredos permanecem em variáveis de ambiente. Para trocar para Meta ou WAHA, preencha as credenciais correspondentes no servidor; o painel não mostra nem armazena esses segredos.

O painel não consegue detectar todas as mensagens manuais da equipe em todos os provedores. Use a atribuição `HUMANO` ou `PAUSADO` antes de responder manualmente. No WAHA/Baileys, as etiquetas são conferidas antes de cada envio para bloquear uma transferência que ainda não chegou ao banco local.

## Provedores de IA e áudio

- **Ollama** é a opção padrão e executa localmente. O agente pede uma saída JSON limitada aos campos do perfil e valida a resposta com Zod. A documentação do Ollama descreve o modo de [saída estruturada com JSON Schema](https://ollama.com/blog/structured-outputs).
- **Gemini** é opcional e externo. Quando selecionado, o aviso externo é enviado antes de qualquer extração; materiais e notas internas nunca são enviados. Cota, timeout, erro de rede ou JSON inválido não geram uma resposta livre: o trabalho aguarda, pede esclarecimento com texto fixo ou é encaminhado.
- **Áudio** começa desativado. Se ativado com Gemini, o aviso externo é enviado antes da primeira transcrição. O arquivo é limitado por tamanho, removido após a tentativa e não é armazenado como material de referência. Transcrição local ainda não está implementada.

Instale o Ollama no host, baixe um modelo compatível e ajuste `OLLAMA_API_URL` e `OLLAMA_MODEL` no `.env`. Exemplo de modelo: `ollama pull qwen3:4b`. A capacidade e a qualidade dependem do hardware e do modelo configurado.

## Instalação com Docker Compose

Requisitos: Docker Compose, Node.js 22+ para desenvolvimento e espaço protegido para o SQLite e a sessão WhatsApp.

1. Copie `.env.example` para `.env` e `config/qualification.example.json` para `config/qualification.json`.
2. Substitua os marcadores de WAHA por segredos aleatórios diferentes. Não use os valores de exemplo em operação real. Não compartilhe `.env`, `data/`, `data/auth/` ou o volume de sessão.
3. Inicie o app e o WAHA:

   ```sh
   docker compose up -d --build
   ```

4. Acesse o painel em `http://localhost:3000`. As portas do Compose ficam vinculadas ao loopback. A senha aleatória do painel é gravada em `data/panel-password`, a menos que `PANEL_PASSWORD` esteja definida.
5. Na página **Conexão WhatsApp**, confira o status e leia o QR somente quando decidir conectar um número de teste. Não use um número de cliente.

Para Ollama em host Docker, o Compose usa `host.docker.internal:11434` por padrão; configure `OLLAMA_API_URL_DOCKER` se o serviço estiver em outro endereço. O Compose sobe WAHA mesmo que outro provedor esteja selecionado; para produção com Meta, prefira uma implantação em que o webhook `/api/meta/webhook` seja publicado por HTTPS e o WAHA não seja necessário.

O processo pode ser executado diretamente com Node.js. O provedor deve estar acessível no endereço configurado e, para webhooks WAHA, também precisa alcançar `/api/waha/webhook`. Para Meta, configure `WHATSAPP_PROVIDER=meta` como fallback inicial ou selecione **Meta Cloud API** no painel; informe `META_ACCESS_TOKEN`, `META_PHONE_NUMBER_ID`, `META_GRAPH_API_VERSION`, `META_APP_SECRET` e `META_WEBHOOK_VERIFY_TOKEN`. Configure no painel da Meta o webhook público `https://seu-dominio/api/meta/webhook` com a mesma chave de verificação. Não exponha o painel sem HTTPS e senha forte.

No primeiro início, o painel pode gerar uma senha em `data/panel-password`. Em VPS, prefira túnel SSH ou proxy HTTPS e mantenha as portas administrativas fechadas para a internet. Faça backups protegidos de `data/`, do volume `waha_sessions` e do arquivo de configuração. O banco guarda conversas, contatos, estado da triagem e fila; os backups são dados pessoais.

## Configurações do painel

O painel configura:

- provedor WhatsApp, provedor de IA, política da primeira mensagem e transcrição de áudio;
- perfis, campos, perguntas, tipos de resposta, opções e condições;
- textos de abertura, aviso virtual, privacidade, aviso externo, esclarecimento, urgência, conclusão e encaminhamento;
- termos configuráveis de urgência, pedido de atendimento humano, perguntas jurídicas e temas que devem ir à equipe;
- tamanho e quantidade de balões, agrupamento de mensagens, atraso, presença de digitação e limites por contato e globais;
- retenção, revisão e restauração de configuração.

Os termos de elegibilidade no WAHA/Baileys são os nomes `Bot - atendimento`, `Atendimento` e `Novo Lead`. `Atendimento` prevalece sobre a lista Bot. No provedor Meta, use a lista interna da página **Contatos e listas**. Os textos de abertura e pergunta são conteúdo editável; o campo “nota de redação” serve à equipe e não muda a resposta do bot.

O envio para a equipe via `HUMAN_NOTIFY_JID` funciona nos provedores WhatsApp Web. O adaptador Meta não envia resumo interno: o encaminhamento fica registrado no painel, pois a integração não implementa mensagens template para esse destino.

## Dados, autorização e retenção

- Mensagens recebidas e saídas, estado de conversas e fila ficam em SQLite com WAL; o projeto pressupõe uma única instância.
- O prazo `retentionDays` remove mensagens processadas, diagnósticos e itens terminais de fila/saída. Mensagens de entrada ainda pendentes são preservadas. A limpeza não substitui política de backup, controle de acesso ou exclusão legal.
- Arquivos de áudio temporários são removidos após a transcrição ou encaminhamento. Não faça backup de `data/tmp/`.
- O painel exige senha e usa sessão `HttpOnly`/`SameSite`. Restrinja o acesso ao host e ao armazenamento; não publique `data/`, arquivos de autenticação ou logs.
- Logs evitam conteúdo de conversa e telefone; o banco e a tela de diagnóstico exibem identificadores de contato para operação restrita.
- `maxMessagesSentPerDay` e `maxMessagesSentPerMonth` são limites internos do agente, não cotas da Meta ou do WAHA.

## Verificação local

Use Node.js 22+:

```sh
npm ci --allow-git=all
npm run lint
npm test
npm run typecheck
npm run build
docker compose config --quiet
```

Os testes usam banco temporário, servidor HTTP local e mocks de `fetch`; não pareiam WhatsApp nem enviam mensagens reais. A CI executa as mesmas verificações e valida o Compose com valores de ambiente fictícios.

## Limitações conhecidas

- O adaptador Meta não implementa envio de templates, confirmação de entrega, diagnóstico de saúde remoto, transcrição de áudio ou alerta interno via WhatsApp. O código apenas valida a configuração e o recebimento assinado do webhook.
- O aviso externo é informativo; o escritório deve revisar sua redação e a base legal aplicável ao uso de dados antes de ativar Gemini. A integração não valida políticas de retenção do provedor externo.
- Transcrição local de áudio, janela de atendimento/expediente, condições de encaminhamento em árvore e listas de exclusão configuráveis ainda não estão implementadas.
- Eventos repetidos são deduplicados e envios incertos são pausados, mas não há garantia de entrega exatamente uma vez entre SQLite e API externa.
- Etiquetas do WhatsApp Web podem perder sincronização ou ficar indisponíveis. Em caso de dúvida, o agente deve permanecer pausado até revisão.
