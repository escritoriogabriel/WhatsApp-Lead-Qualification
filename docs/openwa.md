# Integração com o OpenWA

O [OpenWA](https://github.com/rmyndharis/OpenWA) é o gateway self-hosted de WhatsApp desta aplicação. Ele cuida da sessão do WhatsApp, do envio e recebimento de mensagens, dos webhooks e das etiquetas. A aplicação continua dona de autenticação, autorização por etiquetas, regras de negócio, fila, persistência, auditoria e das mensagens fixas de triagem.

## Decisão de arquitetura

```
WhatsApp ↔ OpenWA (sessão, REST, webhooks)
              ↕  X-API-Key (somente backend)
      backend desta aplicação
        ├── autorização por etiquetas nativas
        ├── regras de triagem e mensagens fixas
        ├── SQLite: conversas, fila, outbox, auditoria
        └── IA de extração (opcional, externa)
              ↕
        painel/operadores (nunca falam com o OpenWA)
```

**Modo B — o backend da aplicação é o único que responde.** O plugin oficial `ai-responder` **não** é instalado nem habilitado. Não há dois agentes respondendo ao mesmo chat. Se algum dia o plugin for habilitado em uma sessão de teste, a triagem desta aplicação precisa ser desligada naquele número.

Motivo: a triagem usa histórico, estado de conversa, autorização por etiquetas, aprovação/handoff e mensagens fixas. O `ai-responder` é single-turn, não tem memória nem handoff e não conhece as regras do escritório.

O frontend nunca recebe a chave do OpenWA e nunca chama o gateway. Toda chamada parte de `src/openwa.ts`.

## Versões

| Componente | Versão usada |
|---|---|
| Imagem do gateway | `rmyndharis/openwa:0.30.3` (pinada no `compose.yaml`; `:latest` só para teste local) |
| Contrato REST consultado | documentação v0.30.0 (`/api` prefix, `X-API-Key`) |
| Mecanismo do WhatsApp | `whatsapp-web.js` (obrigatório — ver etiquetas) |
| Node da aplicação | 22+ |

Antes de atualizar o gateway, confira o changelog e refaça os testes locais. O adaptador depende de rotas estáveis desde v0.19–v0.25: `/sessions`, `/sessions/{id}/qr`, `/sessions/{id}/messages/send-text`, `/sessions/{id}/chats/typing`, `/sessions/{id}/labels*`, `/sessions/{id}/webhooks`.

## Como executar

### Com Docker Compose (recomendado)

1. Copie `.env.example` para `.env`.
2. Defina `OPENWA_API_KEY` com uma chave de operação (role `operator` ou `viewer`+escopo de sessão, nunca a chave ADMIN do navegador) e `OPENWA_WEBHOOK_SECRET` com 16–255 caracteres aleatórios.
3. Suba os serviços:

   ```sh
   docker compose up -d --build
   ```

4. Leia a chave ADMIN gerada na primeira subida (necessária apenas para o painel do gateway e para criar chaves):

   ```sh
   docker exec -it <container_openwa> cat /app/data/.api-key
   ```

5. Abra `http://127.0.0.1:2785`, crie a sessão `triagem` (ou deixe a aplicação criá-la), inicie e leia o QR com um **número de teste**.
6. No painel desta aplicação, em **Conexão WhatsApp**, selecione **OpenWA**. O status deve ficar "Conectado".

A aplicação também cria a sessão e registra o webhook automaticamente quando `OPENWA_SESSION_ID` está vazio: procura a sessão por `OPENWA_SESSION_NAME` e, se não existir, cria.

### Sem Docker

Rode o gateway conforme a documentação oficial (`npm ci && npm run start:prod`, porta 2785) e aponte `OPENWA_BASE_URL` para ele.

## Variáveis de ambiente

| Variável | Obrigatória | Uso |
|---|---|---|
| `OPENWA_BASE_URL` | sim | Origem do gateway, ex. `http://localhost:2785`. O `/api` é acrescentado pelo adaptador. |
| `OPENWA_API_KEY` | sim | Chave enviada em `X-API-Key`. Somente no backend. |
| `OPENWA_SESSION_ID` | não | UUID da sessão. Vazio = resolver/criar por nome. |
| `OPENWA_SESSION_NAME` | não | Nome da sessão quando não há id (padrão `triagem`, 3–50 caracteres `[a-zA-Z0-9-]`). |
| `OPENWA_WEBHOOK_URL` | sim | URL que o gateway chama em `message.received`/`session.status`. |
| `OPENWA_WEBHOOK_SECRET` | sim | Segredo HMAC do webhook (16–255 caracteres). |
| `OPENWA_IMAGE` / `OPENWA_API_MASTER_KEY` | só Compose | Imagem pinada e chave ADMIN de instalação do gateway. |

A seleção do provedor fica em `config/qualification.json` (ou no painel) e prevalece sobre `WHATSAPP_PROVIDER`.

## Webhooks e assinatura

Endpoint: `POST /api/openwa/webhook` (público, sem sessão do painel).

- O corpo cru é lido antes de qualquer parse e a assinatura `X-OpenWA-Signature: sha256=<hex>` é conferida com HMAC-SHA256 usando `OPENWA_WEBHOOK_SECRET`, em tempo constante. Assinatura ausente, malformada ou corpo alterado recebem `401`.
- Eventos aceitos: `message.received` e `session.status`. Outros são ignorados.
- A entrega é *at-least-once*. A deduplicação usa a chave `${jid}:${messageId}` já gravada no SQLite antes de qualquer efeito; reentregas não criam respostas nem registros duplicados.
- `fromMe`, grupos, canais, status/broadcast e eventos de outra sessão são descartados.
- Áudio: o webhook traz base64 até o limite configurado no gateway; acima disso vem o marcador `omitted` e o adaptador baixa pela rota de mídia da mensagem, sempre com o mesmo `X-API-Key` e limite de bytes.
- O adaptador registra/atualiza o webhook da sessão na inicialização (segredo é *write-only* na API, então é reenviado ao atualizar).

Em rede interna do Compose, o gateway recusa URLs internas por padrão; por isso o serviço define `WEBHOOK_SSRF_PROTECT=false`. Em produção, prefira um webhook público HTTPS e mantenha a proteção SSRF ligada.

## Etiquetas (autorização)

A autorização continua sendo: `Bot - atendimento` presente **e** `Clientes` ausente.

Restrição real do OpenWA: **ler** etiquetas só funciona no mecanismo `whatsapp-web.js`; **criar/editar** etiqueta só funciona no `baileys` (`501` no outro). Como a autorização depende da leitura, use `whatsapp-web.js` e crie antes, no aplicativo WhatsApp Business, as etiquetas `Novo Lead`, `Bot - atendimento`, `Atendimento` e `Clientes`. Se faltar alguma, o adaptador falha com mensagem explicando o que criar — ele não inventa ids de etiqueta.

O gateway não emite eventos de alteração de etiqueta. Consequências:

- remover `Bot - atendimento` bloqueia o próximo envio imediatamente (a leitura acontece antes de cada envio);
- remover `Clientes` é percebido na próxima mensagem ou quando o trabalho pendente é reprocessado.

## IA e privacidade

- A IA de extração é opcional e continua desativada até configuração explícita no painel; ela apenas extrai campos, nunca redige mensagens ao contato.
- Com Gemini, o aviso de processamento externo é enviado antes de qualquer conteúdo ir ao provedor.
- O OpenWA não envia dados a provedores de IA nesta integração (plugin `ai-responder` desabilitado).
- O gateway guarda histórico de mensagens no próprio banco (`openwa_data`). Isso é dado pessoal: proteja o volume, faça backup cifrado e aplique retenção.

## Operação (runbook)

| Sintoma | Verificação | Ação |
|---|---|---|
| Status `SCAN_QR_CODE` | QR no painel | Ler o QR com o número de teste em Aparelhos conectados |
| Status `DISCONNECTED`/`FAILED` | Logs do gateway e da aplicação | Botão "Reiniciar sessão" (`stop`+`start`) ou reiniciar o container; se pedir QR, parear de novo |
| `HTTP 401` | `OPENWA_API_KEY` | Gerar nova chave de operação no gateway e atualizar o `.env`; reiniciar a aplicação |
| `HTTP 403` | Escopo da chave | Incluir a sessão em `allowedSessions` ou usar chave de operação sem restrição de chat |
| `HTTP 409` | Sessão não pronta | Aguardar `ready`; a fila reprocessa |
| `HTTP 429` | `Retry-After` | O adaptador converte em espera e o trabalho é reagendado |
| `HTTP 5xx` no envio | Resultado incerto | A saída fica pausada para revisão. Confira o chat antes de reenviar; não há reenvio automático |
| Webhook não chega | `OPENWA_WEBHOOK_URL`, SSRF, logs do gateway | URL pública HTTPS ou `WEBHOOK_SSRF_PROTECT=false` em rede interna; conferir o segredo |
| Etiqueta não encontrada | App WhatsApp Business | Criar as quatro etiquetas e tentar novamente |
| `501` em etiquetas | `ENGINE_TYPE` | Usar `whatsapp-web.js`; `baileys` não lê etiquetas |

Backup: `data/` (SQLite, sessão Baileys se usada) e o volume `openwa_data` (banco, mídia e credenciais da sessão WhatsApp). Restaure os dois juntos.

Rollback: no painel, volte o provedor para WAHA/Baileys ou pare o serviço `openwa`. Nada é apagado: mensagens, fila, credenciais de sessão e configuração permanecem.

## Limitações e riscos

- `whatsapp-web.js` usa o protocolo do WhatsApp Web: risco de desconexão e restrição da conta, igual ao WAHA/Baileys. Não é a API oficial.
- Sem idempotência por mensagem no envio: o adaptador não conhece o identificador da saída antes da chamada, então resultado ambíguo é tratado como "desconhecido" e não é reenviado.
- Sem eventos de etiqueta, a retomada após remover `Clientes` pode esperar a próxima mensagem.
- A criação de etiquetas depende do aplicativo WhatsApp Business; a integração não contorna essa limitação do gateway.
- O webhook é a única fonte de mensagens recebidas; se ele falhar, a aplicação não recebe nada (o gateway tenta novamente até `retryCount`).
- O `ai-responder` é beta e single-turn; habilitá-lo junto com esta triagem causaria respostas duplicadas.

## Testes

```sh
npm run lint
npm run typecheck
npm test
npm run build
docker compose config --quiet
```

`src/openwa.test.ts` cobre, com servidor HTTP local e dados sintéticos: autenticação por `X-API-Key`, resolução/criação de sessão, registro de webhook com segredo, envio com `chatId` normalizado, `429`/`5xx`, digitação, leitura e atribuição de etiquetas, bloqueio por `Clientes`, renomeação de contato, normalização de mensagens (texto, áudio inline e `omitted`, `fromMe`, grupo, outra sessão), assinatura HMAC válida/inválida/corpo alterado e falha fechada com `401`. Nenhum teste pareia WhatsApp ou envia mensagem real.
