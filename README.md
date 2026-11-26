# WhatsApp Lead Qualification

Aplicação local-first para acolhimento e triagem inicial de leads de um escritório de advocacia. O bot coleta somente os campos configurados, usa mensagens fixas e encaminha dúvidas jurídicas individuais, urgências, baixa confiança e pedidos de atendimento humano à equipe.

O modelo de IA **não redige mensagens ao contato**, não escolhe quem pode receber resposta, não decide urgência, não encerra atendimento e não avalia direitos, documentos ou provas. Nenhuma automação inicia conversa sem uma mensagem recebida.

## Estado do projeto

Esta versão usa OpenWA, WAHA ou Baileys, uma fila persistente e as listas nativas do WhatsApp para autorizar respostas. O OpenWA é a integração recomendada: ele concentra a sessão, o envio, o recebimento e os webhooks, enquanto esta aplicação continua responsável pela autorização, pelas regras de negócio, pela fila e pela auditoria. A Meta Cloud API é recusada porque o adaptador atual não sincroniza essas listas. A aplicação ainda exige configuração e validação em ambiente controlado antes de qualquer uso com dados reais. Não oferece garantia de envio único ou disponibilidade contínua.

## Como funciona a triagem

1. A mensagem recebida é deduplicada pelo identificador do provedor, gravada no SQLite e colocada na fila antes da confirmação do webhook.
2. No primeiro contato observado, o agente consulta as etiquetas nativas. `Clientes` bloqueia a automação; fora dessa lista, o agente aplica `Novo Lead` e `Bot - atendimento` juntos.
3. A presença de `Bot - atendimento` é a única autorização para responder. `Clientes` bloqueia o envio mesmo quando ambas as etiquetas estão aplicadas.
4. Remover `Bot - atendimento` interrompe o bot. Ao remover `Clientes`, a próxima mensagem permite retomar a triagem. O sistema não importa histórico antigo.
5. As respostas são montadas com textos fixos e perguntas do perfil. A divisão em balões é determinística, respeita limites, aguarda o intervalo configurado e verifica a autorização novamente antes do envio.
6. Falha ao consultar as listas mantém mensagens recebidas pendentes. Falha de envio com resultado incerto mantém a saída em estado técnico de revisão; o sistema não repete esse envio automaticamente nem altera as listas do contato.

Se a configuração usar Gemini, o primeiro conteúdo da conversa **não é enviado ao modelo**. O bot envia primeiro o aviso externo configurado e só considera mensagens recebidas depois desse aviso. A mensagem inicial fica fora da extração externa. Se o aviso não for confirmado pelo provedor, a triagem externa não continua.

## Provedores de WhatsApp

| Provedor | Uso previsto | Autorização | Limitações relevantes |
|---|---|---|---|
| **Meta Cloud API** | Indisponível neste fluxo | — | Não sincroniza as listas nativas usadas para autorizar o bot. A aplicação recusa essa seleção. |
| **OpenWA** | Integração recomendada | Etiquetas/listas lidas antes de cada envio (mecanismo `whatsapp-web.js`) | Gateway self-hosted com API REST, webhooks assinados por HMAC e plugins. Exige etiquetas criadas previamente no WhatsApp Business. Detalhes, versão fixada e runbook em [`docs/openwa.md`](docs/openwa.md). |
| **WAHA / GOWS** | Teste e operação local | Etiquetas/listas do WhatsApp, conferidas antes de cada envio | Usa sessão do WhatsApp Web. Não oferece a mesma garantia operacional da API oficial. Eventos e APIs de etiquetas são documentados pelo [WAHA](https://waha.devlike.pro/docs/how-to/labels/), [eventos](https://waha.devlike.pro/docs/how-to/events/) e [mecanismos](https://waha.devlike.pro/docs/how-to/engines/). |
| **Baileys** | Compatibilidade legada | Etiquetas sincronizadas pela sessão | Também usa o protocolo do WhatsApp Web e depende da sincronização da sessão. Não é a integração indicada para produção. |

A aplicação não inclui campanhas, modelos aprovados, acompanhamento de status de entrega ou automação para contornar limites do provedor. WAHA e Baileys usam uma sessão do WhatsApp Web; avalie as limitações do provedor e do canal antes de operar.

O seletor de provedor fica na página **Conexão WhatsApp**. A seleção e as configurações do assistente são salvas no arquivo JSON com gravação atômica e até 20 revisões. Os segredos permanecem em variáveis de ambiente.

Use a etiqueta `Clientes` para suspender o bot enquanto a pessoa for cliente. WAHA consulta as listas nativas antes de cada envio. Baileys sincroniza o estado `regular` das listas do WhatsApp e atualiza esse espelho antes do envio; se a sincronização falha ou ainda não terminou, as respostas ficam bloqueadas e contatos pendentes são retomados após uma nova sincronização. Essa leitura não importa o histórico de mensagens.

## Provedores de IA e áudio

- **Gemini 3.5 Flash-Lite** é o padrão recomendado após comparação estrita com quatro exemplos sintéticos em português: acertou 4/4, sem JSON inválido ou campos inesperados, com mediana de 3,7 s. A amostra é pequena e não garante desempenho em todos os casos. A integração é externa: o aviso configurado é enviado antes de qualquer extração; materiais e notas internas nunca são enviados. Cota, timeout, erro de rede ou JSON inválido não geram uma resposta livre: o trabalho aguarda, pede esclarecimento com texto fixo ou é encaminhado.
- **Ollama** permanece como alternativa local experimental. Qwen3 0.6B acertou 2/4 e Gemma 3 1B, 0/4 na mesma avaliação estrita; ambos deixaram campos indevidos ou não identificaram fatos. Esta máquina mediu arquivos de 1,02 GB e 883 MB, respectivamente; o processo Ollama chegou a cerca de 1,43 GiB de memória residente e 2,25 GiB privada. A resposta JSON é validada e valores sem trecho literal correspondente nas mensagens recebidas são descartados. A documentação do Ollama descreve o modo de [saída estruturada com JSON Schema](https://ollama.com/blog/structured-outputs).
- **Áudio** começa desativado. Se ativado com Gemini, o aviso externo é enviado antes da primeira transcrição. O arquivo é limitado por tamanho, removido após a tentativa e não é armazenado como material de referência. Transcrição local ainda não está implementada.

O `.env.example` seleciona Gemini 3.5 Flash-Lite e exige uma chave válida do Google AI Studio. Para experimentar localmente, instale o Ollama e baixe `qwen3:0.6b`; a central informa o modelo ativo. A simulação não chama modelos nem envia dados.

## Instalação com Docker Compose

Requisitos: Docker Compose, Node.js 22+ para desenvolvimento e espaço protegido para o SQLite e a sessão WhatsApp.

1. Copie `.env.example` para `.env` e `config/qualification.example.json` para `config/qualification.json`.
2. Substitua os marcadores de OpenWA e WAHA por segredos aleatórios diferentes. Não use os valores de exemplo em operação real. Não compartilhe `.env`, `data/`, `data/auth/` ou o volume de sessão.
3. Inicie o app, o OpenWA e o WAHA:

   ```sh
   docker compose up -d --build
   ```

4. Acesse o painel em `http://localhost:3000`. As portas do Compose ficam vinculadas ao loopback. A senha aleatória do painel é gravada em `data/panel-password`, a menos que `PANEL_PASSWORD` esteja definida.
5. Na página **Conexão WhatsApp**, confira o status e leia o QR somente quando decidir conectar um número de teste. Não use um número de cliente.

Para Ollama em host Docker, o Compose usa `host.docker.internal:11434` por padrão; configure `OLLAMA_API_URL_DOCKER` se o serviço estiver em outro endereço. O Compose sobe OpenWA e WAHA independentemente do provedor selecionado.

O OpenWA sobe em `http://127.0.0.1:2785` (API em `/api`, painel próprio no navegador). A chave do gateway fica no `.env` e só o backend a usa. O serviço do Compose desativa o filtro SSRF de webhook (`WEBHOOK_SSRF_PROTECT=false`) para que o gateway alcance o host interno `app`; fora dessa rede, registre um webhook público HTTPS. Para criar a sessão e parear o número de teste, leia [`docs/openwa.md`](docs/openwa.md).

O processo pode ser executado diretamente com Node.js. Selecione OpenWA, WAHA ou Baileys. Para webhooks, o provedor precisa alcançar `/api/openwa/webhook` ou `/api/waha/webhook`. Não exponha o painel sem HTTPS e senha forte.

No primeiro início, o painel pode gerar uma senha em `data/panel-password`. Em VPS, prefira túnel SSH ou proxy HTTPS e mantenha as portas administrativas fechadas para a internet. Faça backups protegidos de `data/`, do volume `waha_sessions` e do arquivo de configuração. O banco guarda conversas, contatos, estado da triagem e fila; os backups são dados pessoais.

## Configurações do painel

O painel é organizado em páginas:

- **Visão geral** — resumo do fluxo padrão, provedor de IA e atalho para aplicar o modelo de escritório;
- **Mensagens padrão** — identificação do escritório, abertura (com cumprimentos prontos), avisos de assistente, privacidade e processamento externo, confirmação, esclarecimento, conclusão, encaminhamento, urgência, falha da IA e áudio, além do ritmo de envio;
- **Fluxos e perguntas** — áreas, palavras-gatilho, perguntas, tipos de resposta, opções, condições e obrigatoriedade;
- **Eventos e condições** — eventos da conversa por palavra-chave, primeira mensagem, áudio, urgência detectada, pedido de atendimento humano ou conclusão da triagem, com ações de enviar mensagem, avisar a equipe ou pausar; e as listas de termos de urgência, perguntas jurídicas e temas reservados;
- **Estilo e materiais** — tom de voz, contexto do escritório, importação de TXT/MD de conversas para a IA aprender o jeito de falar (até 10 exemplos e 30.000 caracteres) e materiais internos em PDF, TXT, MD, CSV, JSON, DOCX ou ZIP;
- **Testar conversa** — simulação por turnos das mensagens, eventos, condições e limites de balão, sem enviar nada e sem chamar modelo;
- **Conexão WhatsApp**, **Regras das listas** e **Fila e diagnósticos** — operação da sessão, autorização por etiquetas e histórico técnico.

A presença de digitação é limitada a 8 segundos por balão e `typingSecondsPerCharacter` não pode passar de 1: o atraso é apenas cosmético e nunca deve segurar o atendimento. O painel também restaura a última versão salva e mantém até 20 revisões da configuração.

As listas são `Novo Lead`, `Bot - atendimento`, `Clientes` e `Atendimento`. `Clientes` bloqueia o bot; `Atendimento` não autoriza respostas. `Novo Lead` e `Bot - atendimento` coexistem.

O envio para a equipe via `HUMAN_NOTIFY_JID` funciona nos provedores WhatsApp Web. O adaptador Meta não envia resumo interno: o encaminhamento fica registrado no painel, pois a integração não implementa mensagens template para esse destino.

## Dados, listas e retenção

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

Para comparar extração com exemplos sintéticos, instale os modelos locais `qwen3:0.6b` e `gemma3:1b` no Ollama e execute `npm run benchmark:ai`. O ensaio envia apenas textos fixos sintéticos; Gemini só é consultado se `GEMINI_API_KEY` estiver definida no ambiente do processo.

## Limitações conhecidas

- A Meta Cloud API não é compatível com o fluxo de autorização por listas nativas e é bloqueada na configuração.
- O aviso externo é informativo; o escritório deve revisar sua redação e a base legal aplicável ao uso de dados antes de ativar Gemini. A integração não valida políticas de retenção do provedor externo.
- Transcrição local de áudio e janela de atendimento/expediente ainda não estão implementadas.
- Eventos repetidos são deduplicados e envios incertos são pausados, mas não há garantia de entrega exatamente uma vez entre SQLite e API externa.
- Etiquetas do WhatsApp Web podem perder sincronização ou ficar indisponíveis. Em caso de dúvida, o agente deve permanecer pausado até revisão.
- No OpenWA, a leitura de etiquetas existe apenas no mecanismo `whatsapp-web.js`, e a criação/edição de etiquetas apenas no `baileys`. Como a autorização depende da leitura, o OpenWA deve rodar com `whatsapp-web.js` e as quatro etiquetas (`Novo Lead`, `Bot - atendimento`, `Atendimento`, `Clientes`) precisam ser criadas antes no aplicativo WhatsApp Business. O gateway também não emite eventos de alteração de etiqueta: remoções são percebidas na próxima mensagem ou na nova tentativa do trabalho pendente.
- O OpenWA não permite idempotência por mensagem nesta integração, pois o adaptador não recebe o identificador da saída antes do envio. Resultado de envio incerto continua pausado para revisão e não é reenviado automaticamente.
