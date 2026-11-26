import { unlink } from 'node:fs/promises';
import type { Logger } from 'pino';
import type { AssistantConfig, IntakeProfile, RuntimeConfig } from './config.js';
import type { IntakeAIProvider } from './ai.js';
import {
  AgentDatabase,
  type ConversationState,
  type OutboundRateLimits,
  type QueueJob,
  type StoredMessage,
} from './database.js';
import { GeminiQuotaError } from './gemini.js';
import { ProviderRetryAfterError, SendOutcomeUnknownError } from './provider-errors.js';
import type { WhatsAppLabelTarget } from './whatsapp.js';

const MAX_JOB_ATTEMPTS = 5;
// A presença de digitação é apenas cosmética: nunca deve atrasar o atendimento.
const MAX_TYPING_SECONDS = 8;

type ConversationEventTrigger = AssistantConfig['conditionalEvents'][number]['trigger'];

export interface TextSender {
  (jid: string, text: string): Promise<void>;
}

export class LabelAuthorizationUnavailableError extends Error {
  constructor() {
    super('Não foi possível consultar as listas atuais do WhatsApp.');
    this.name = 'LabelAuthorizationUnavailableError';
  }
}

export interface ContactManager {
  setContactLabels(jid: string, target: WhatsAppLabelTarget): Promise<void>;
  getContactLabelNames?: ((jid: string) => Promise<string[]>) | undefined;
  setTyping?: ((jid: string, typing: boolean) => Promise<void>) | undefined;
  renameContact(jid: string, name: string): Promise<void>;
  getStatus?(): Promise<{ connected: boolean }>;
}

export class QualificationWorker {
  constructor(
    private readonly db: AgentDatabase,
    private readonly provider: IntakeAIProvider,
    private readonly getAssistant: () => AssistantConfig,
    private readonly runtime: RuntimeConfig,
    private readonly sendText: TextSender,
    private readonly contacts: ContactManager,
    private readonly logger: Logger,
  ) {}

  private get assistant(): AssistantConfig {
    return this.getAssistant();
  }

  async run(signal: AbortSignal): Promise<void> {
    let lastRetentionSweep = 0;
    while (!signal.aborted) {
      try {
        if (Date.now() - lastRetentionSweep >= 24 * 60 * 60 * 1000) {
          for (const path of this.db.expireData(this.assistant.retentionDays)) await unlink(path).catch(() => undefined);
          lastRetentionSweep = Date.now();
        }
        await this.flushOutbox();
        const job = this.db.claimDueJob();
        if (!job) {
          await delay(this.assistant.workerPollMs, signal);
          continue;
        }
        this.db.recordDiagnostic(job.jid, 'processando', `Tarefa ${job.id}; tentativa ${job.attempts}`);
        await this.processJob(job);
      } catch (error) {
        if (signal.aborted) break;
        this.logger.error({ error: safeError(error) }, 'Worker iteration failed');
        await delay(this.assistant.workerPollMs, signal);
      }
    }
  }

  private async processJob(job: QueueJob): Promise<void> {
    try {
      if (job.kind === 'start_conversation') await this.startConversation(job);
      else await this.processConversation(job);
      this.db.completeJob(job.id);
      this.db.recordDiagnostic(job.jid, 'processada', `Tarefa ${job.id} concluída`);
    } catch (error) {
      if (error instanceof LabelAuthorizationUnavailableError) {
        this.db.deferJob(job.id, 60_000, error.message);
        this.db.recordDiagnostic(job.jid, 'aguardando-listas', 'Consulta das listas indisponível; mensagem mantida pendente sem resposta e nova tentativa agendada.');
        this.logger.warn({ jobId: job.id }, 'Native label query unavailable; conversation deferred');
        return;
      }
      if (error instanceof GeminiQuotaError) {
        this.db.deferJob(job.id, error.retryAfterMs, error.message);
        const resumesAt = new Date(Date.now() + error.retryAfterMs).toLocaleString('pt-BR');
        this.db.recordDiagnostic(job.jid, 'aguardando-cota', `Cota gratuita do Gemini atingida; mensagem mantida na fila. Nova tentativa após ${resumesAt}.`);
        this.logger.warn({ jobId: job.id, resumesAt }, 'Gemini quota reached; conversation job deferred');
        return;
      }
      const failure = safeError(error);
      const exhausted = this.db.retryJob(
        job.id,
        job.attempts,
        failure,
        MAX_JOB_ATTEMPTS,
      );
      this.logger.error(
        { jobId: job.id, attempts: job.attempts, error: failure },
        exhausted ? 'Conversation job exhausted retries' : 'Conversation job will retry',
      );
      this.db.recordDiagnostic(job.jid, 'falha', `Tarefa ${job.id}: ${failure}`);

      if (exhausted) {
        const state = this.db.getConversationState(job.jid);
        await this.handoff(job, job.jid, state, this.db.getRecentMessages(job.jid, this.assistant.maxHistoryMessages), 'Falha repetida no processamento');
        this.db.markMessagesProcessed(
          this.db.getUnprocessedMessages(job.jid).map((message) => message.id),
        );
      }
    }
  }

  private async startConversation(job: QueueJob): Promise<void> {
    if (this.db.getUnprocessedMessages(job.jid).length === 0) {
      this.db.recordDiagnostic(job.jid, 'ignorada', 'A alteração de listas sozinha não inicia uma conversa; aguarda-se uma mensagem recebida.');
      return;
    }
    await this.processConversation(job);
  }

  private async processConversation(job: QueueJob): Promise<void> {
    let incoming = this.db.getUnprocessedMessages(job.jid);
    if (incoming.length === 0) return;

    const state = this.db.getConversationState(job.jid);
    if (!(await this.isAuthorized(job.jid))) {
      this.db.recordDiagnostic(job.jid, 'aguardando-autorizacao', 'Mensagem pendente preservada porque as listas atuais não autorizam a resposta.');
      return;
    }
    if (state.externalDisclosureAfterMessageId !== null) {
      const preDisclosure = incoming.filter((message) => message.id <= state.externalDisclosureAfterMessageId!);
      this.db.markMessagesProcessed(preDisclosure.map((message) => message.id));
      incoming = incoming.filter((message) => message.id > state.externalDisclosureAfterMessageId!);
      if (incoming.length === 0) return;
    }

    const usesExternalAI = this.assistant.aiProvider === 'gemini' || this.assistant.audioTranscriptionProvider === 'gemini';
    if (usesExternalAI && state.externalDisclosureAfterMessageId === null) {
      const initialText = incoming.filter((message) => message.kind === 'text').map((message) => message.body ?? '').join(' ').trim();
      const historyBeforeDisclosure = this.db.getRecentMessages(job.jid, this.assistant.maxHistoryMessages);
      if (initialText && this.isHumanCommand(initialText)) {
        await this.handoff(job, job.jid, state, historyBeforeDisclosure, 'Solicitação de atendimento humano');
        this.db.markMessagesProcessed(incoming.map((message) => message.id));
        return;
      }
      if (initialText && containsAny(initialText, this.assistant.handoffKeywords)) {
        await this.deliver(job, job.jid, [this.assistant.urgencyMessage], 'urgency-client');
        state.paused = true;
        this.db.saveConversationState(job.jid, state);
        await this.setContactLabels(job.jid, 'HUMANO');
        await this.notifyHuman(job, job.jid, state, 'Palavra de urgência detectada', historyBeforeDisclosure);
        this.db.markMessagesProcessed(incoming.map((message) => message.id));
        return;
      }
      if (initialText && (containsAny(initialText, this.assistant.legalQuestionKeywords) || containsAny(initialText, this.assistant.forbiddenTopics))) {
        await this.handoff(job, job.jid, state, historyBeforeDisclosure, 'Dúvida ou tema encaminhado à equipe');
        this.db.markMessagesProcessed(incoming.map((message) => message.id));
        return;
      }
      await this.deliver(job, job.jid, [this.assistant.externalProviderNotice], 'external-provider-notice');
      const noticeParts = splitTextDeterministically([this.assistant.externalProviderNotice], this.assistant.maxCharsPerMessage, this.assistant.maxMessagesPerTurn).messages;
      const noticeDelivered = noticeParts.length > 0 && noticeParts.every((_, index) =>
        this.db.getOutboundStatus(job.id + ':external-provider-notice:' + index) === 'sent');
      if (!noticeDelivered) {
        this.db.recordDiagnostic(job.jid, 'aviso-provedor-externo-pendente', 'O aviso de processamento externo ainda não teve envio confirmado; o conteúdo permanece fora da IA externa.');
        return;
      }
      state.externalDisclosureAfterMessageId = Math.max(...incoming.map((message) => message.id));
      this.db.saveConversationState(job.jid, state);
      const discardedMedia = this.db.clearMessageMedia(incoming.map((message) => message.id));
      await Promise.all(discardedMedia.map((path) => unlink(path).catch(() => undefined)));
      this.db.markMessagesProcessed(incoming.map((message) => message.id));
      this.db.recordDiagnostic(job.jid, 'aviso-provedor-externo', 'A primeira mensagem foi excluída do processamento externo; o aviso foi enviado antes de usar o Gemini.');
      if (state.profileId === null && state.pendingFieldId === null && Object.keys(state.fields).length === 0) {
        const initialProfile = this.chooseProfile(initialText, state);
        const initialField = initialProfile.fields.find((field) => field.id === this.assistant.areaFieldId && this.shouldAsk(field, state))
          ?? initialProfile.fields.find((field) => field.required && this.shouldAsk(field, state));
        if (initialField) {
          state.profileId = initialProfile.id;
          state.pendingFieldId = initialField.id;
          this.db.saveConversationState(job.jid, state);
          const opening = [this.assistant.greeting, this.assistant.assistantNotice, this.assistant.privacyNotice].filter(Boolean).join(' ');
          const question = initialField.id === this.assistant.areaFieldId ? this.assistant.areaQuestion : initialField.question;
          await this.deliver(job, job.jid, [opening, question], 'post-external-notice-' + initialField.id);
        }
      }
      return;
    }

    let audioFailed = false;
    for (const message of incoming) {
      if (message.kind !== 'audio') continue;
      if (this.assistant.audioTranscriptionProvider === 'disabled') {
        audioFailed = true;
        if (message.mediaPath) await unlink(message.mediaPath).catch(() => undefined);
        continue;
      }
      if (!message.mediaPath) {
        audioFailed = true;
        continue;
      }
      try {
        if (this.assistant.audioResponseDelaySeconds > 0) {
          await delaySeconds(this.assistant.audioResponseDelaySeconds);
        }
        const transcript = await this.provider.transcribe(
          message.mediaPath,
          this.assistant.maxAudioBytes,
          this.assistant.audioTranscriptionTimeoutSeconds,
        );
        this.db.saveTranscript(message.id, transcript);
      } catch (error) {
        audioFailed = true;
        this.db.saveTranscript(message.id, '');
        this.logger.warn(
          { messageId: message.id, error: safeError(error) },
          'Audio transcription failed',
        );
      } finally {
        await unlink(message.mediaPath).catch(() => undefined);
      }
    }

    if (audioFailed) {
      await this.handoff(job, job.jid, state, this.db.getRecentMessages(job.jid, this.assistant.maxHistoryMessages), 'Áudio sem transcrição disponível ou compreensível', this.assistant.audioRetryMessage);
      this.db.markMessagesProcessed(incoming.map((message) => message.id));
      return;
    }

    const recentHistory = this.db.getRecentMessages(
      job.jid,
      this.assistant.maxHistoryMessages,
    );
    const history = usesExternalAI && state.externalDisclosureAfterMessageId !== null
      ? recentHistory.filter((message) => message.direction === 'outbound' || message.id > state.externalDisclosureAfterMessageId!)
      : recentHistory;
    const userText = incoming
      .map((message) => message.body ?? '')
      .join(' ')
      .trim();

    if (await this.runConditionalEvents(job, job.jid, state, incoming, userText, history)) {
      this.db.markMessagesProcessed(incoming.map((message) => message.id));
      return;
    }

    if (this.isHumanCommand(userText)) {
      await this.runTriggeredEvents(job, job.jid, state, 'human_requested', history);
      await this.handoff(job, job.jid, state, history, 'Solicitação de atendimento humano');
      this.db.markMessagesProcessed(incoming.map((message) => message.id));
      return;
    }

    if (containsAny(userText, this.assistant.handoffKeywords)) {
      await this.deliver(
        job,
        job.jid,
        [this.assistant.urgencyMessage],
        'urgency-client',
      );
      await this.runTriggeredEvents(job, job.jid, state, 'urgent', history);
      state.paused = true;
      this.db.saveConversationState(job.jid, state);
      await this.setContactLabels(job.jid, 'HUMANO');
      await this.notifyHuman(job, job.jid, state, 'Palavra de urgência detectada');
      this.db.markMessagesProcessed(incoming.map((message) => message.id));
      return;
    }

    if (containsAny(userText, this.assistant.legalQuestionKeywords) || containsAny(userText, this.assistant.forbiddenTopics)) {
      await this.handoff(job, job.jid, state, history, 'Dúvida ou tema encaminhado à equipe');
      this.db.markMessagesProcessed(incoming.map((message) => message.id));
      return;
    }

    const previousProfileId = state.profileId;
    const profile = this.chooseProfile(userText, state);
    const switchingProfile = previousProfileId !== null && previousProfileId !== profile.id;
    if (switchingProfile) {
      state.fields = {};
      state.skippedFields = [];
      state.attempts = {};
      state.pendingFieldId = null;
      state.completed = false;
      state.paused = false;
      this.db.recordDiagnostic(job.jid, 'fluxo-alterado', `Fluxo atualizado para ${profile.label} por indicação explícita na mensagem.`);
    }
    const firstTurn = !switchingProfile &&
      state.profileId === null &&
      state.pendingFieldId === null &&
      Object.keys(state.fields).length === 0;
    state.profileId = profile.id;
    let extraction;
    try {
      extraction = await this.provider.extract(profile, history, state.fields, this.assistant);
    } catch (error) {
      if (error instanceof GeminiQuotaError) throw error;
      this.db.recordDiagnostic(job.jid, 'falha-ia', 'A extração não foi validada; triagem encaminhada à equipe sem gerar resposta livre.');
      await this.handoff(job, job.jid, state, history, 'Falha ou baixa confiança na extração automática', this.assistant.aiFallbackMessage);
      this.db.markMessagesProcessed(incoming.map((message) => message.id));
      return;
    }
    if (!(await this.isAuthorized(job.jid))) {
      this.db.recordDiagnostic(job.jid, 'aguardando-autorizacao', 'A autorização mudou durante a extração; a mensagem permanece pendente.');
      return;
    }
    const askedFieldId = state.pendingFieldId;
    const capturedAskedField = askedFieldId ? extraction.capturedFields[askedFieldId] : undefined;
    if (askedFieldId && !capturedAskedField) {
      const attempts = (state.attempts[askedFieldId] ?? 0) + 1;
      state.attempts[askedFieldId] = attempts;
      const askedField = profile.fields.find((field) => field.id === askedFieldId);
      if (attempts >= this.assistant.maxFieldAttempts || !askedField) {
        await this.handoff(job, job.jid, state, history, 'Resposta não compreendida após as tentativas configuradas');
      } else {
        state.pendingFieldId = askedField.id;
        this.db.saveConversationState(job.jid, state);
        await this.deliver(job, job.jid, [this.assistant.clarificationMessage, askedField.question], 'clarification-' + askedField.id);
      }
      this.db.markMessagesProcessed(incoming.map((message) => message.id));
      return;
    }
    if (askedFieldId) delete state.attempts[askedFieldId];
    state.fields = { ...state.fields, ...extraction.capturedFields };
    const nameField = profile.fields.find((field) => field.contactName);
    const capturedName = nameField && state.pendingFieldId === nameField.id
      ? extraction.capturedFields[nameField.id]
      : undefined;
    if (capturedName) {
      const cleanedName = capturedName.trim().replace(/\s+/g, ' ').slice(0, 120);
      if (cleanedName) {
        this.db.setContactName(job.jid, cleanedName);
        await this.contacts.renameContact(job.jid, cleanedName);
      }
    }

    let nextField = profile.fields.find(
      (field) =>
        !state.fields[field.id] &&
        !state.skippedFields.includes(field.id) &&
        this.shouldAsk(field, state),
    );

    if (
      nextField &&
      state.pendingFieldId === nextField.id &&
      !state.fields[nextField.id]
    ) {
      const attempts = (state.attempts[nextField.id] ?? 0) + 1;
      state.attempts[nextField.id] = attempts;
      if (attempts >= this.assistant.maxFieldAttempts) {
        state.skippedFields = [...state.skippedFields, nextField.id];
        nextField = profile.fields.find(
          (field) =>
            !state.fields[field.id] &&
            !state.skippedFields.includes(field.id) &&
            this.shouldAsk(field, state),
        );
      }
    }

    if (!nextField) {
      await this.deliver(
        job,
        job.jid,
        [this.assistant.completionMessage],
        'completion-client',
      );
      await this.runTriggeredEvents(job, job.jid, state, 'completed', history);
      state.pendingFieldId = null;
      state.completed = true;
      state.paused = true;
      this.db.saveConversationState(job.jid, state);
      await this.setContactLabels(job.jid, 'HUMANO');
      await this.notifyHuman(job, job.jid, state, 'Triagem concluída');
    } else {
      const areaUnknown = firstTurn && !state.fields[this.assistant.areaFieldId];
      const askedField = areaUnknown
        ? profile.fields.find((field) => field.id === this.assistant.areaFieldId) ?? nextField
        : nextField;
      state.pendingFieldId = askedField.id;
      this.db.saveConversationState(job.jid, state);
      const parts = firstTurn
        ? [
            [this.assistant.greeting, this.assistant.assistantNotice, this.assistant.privacyNotice].filter(Boolean).join(' '),
            areaUnknown ? this.assistant.areaQuestion : nextField.question,
          ]
        : [this.assistant.acknowledgementMessage, nextField.question];
      await this.deliver(
        job,
        job.jid,
        parts,
        'qualification-' + nextField.id,
      );
    }

    this.db.markMessagesProcessed(incoming.map((message) => message.id));
  }

  private async runConditionalEvents(
    job: QueueJob,
    jid: string,
    state: ConversationState,
    incoming: StoredMessage[],
    userText: string,
    history: StoredMessage[],
  ): Promise<boolean> {
    const events = (this.assistant.conditionalEvents ?? []).filter((event) => {
      if (!event.enabled) return false;
      if (event.trigger === 'first_message') return history.filter((message) => message.direction === 'inbound').length <= incoming.length;
      if (event.trigger === 'audio') return incoming.some((message) => message.kind === 'audio');
      if (event.trigger === 'keyword') return event.keywords.some((keyword) => normalize(userText).includes(normalize(keyword)));
      return false;
    });
    if (!events.length) return false;
    const event = events[0]!;
    const suffix = 'conditional-event-' + event.id;
    if (event.action === 'send_message') {
      if (event.message.trim()) await this.deliver(job, jid, [event.message], suffix);
      this.db.recordDiagnostic(jid, 'evento-condicional', `Evento executado: ${event.name}`);
      return Boolean(event.message.trim());
    }
    if (event.action === 'pause') {
      if (event.message.trim()) await this.deliver(job, jid, [event.message], suffix);
      state.paused = true;
      this.db.saveConversationState(jid, state);
      await this.setContactLabels(jid, 'HUMANO');
      this.db.recordDiagnostic(jid, 'evento-condicional', `Automação pausada: ${event.name}`);
      return true;
    }
    await this.handoff(job, jid, state, history, `Evento condicional: ${event.name}`, event.message.trim() || undefined);
    return true;
  }

  private async runTriggeredEvents(
    job: QueueJob,
    jid: string,
    state: ConversationState,
    trigger: ConversationEventTrigger,
    history: StoredMessage[],
  ): Promise<void> {
    const events = (this.assistant.conditionalEvents ?? []).filter(
      (event) => event.enabled && event.trigger === trigger,
    );
    for (const event of events) {
      if (event.action === 'notify_human') {
        await this.notifyHuman(job, jid, state, `Evento da conversa: ${event.name}`, history);
      } else if (event.message.trim()) {
        await this.deliver(job, jid, [event.message], 'conversation-event-' + event.id);
      }
      this.db.recordDiagnostic(jid, 'evento-conversa', `Evento executado: ${event.name}`);
    }
  }

  private chooseProfile(
    text: string,
    state: ConversationState,
  ): IntakeProfile {
    const normalized = normalize(text);
    const matched = this.assistant.profiles.find((profile) =>
      profile.triggers.some((trigger) => normalized.includes(normalize(trigger))),
    );
    if (matched) return matched;
    const existing = this.assistant.profiles.find(
      (profile) => profile.id === state.profileId,
    );
    if (existing) return existing;
    return (
      matched ??
      this.assistant.profiles.find(
        (profile) => profile.id === this.assistant.defaultProfileId,
      )!
    );
  }

  private async handoff(
    job: QueueJob,
    jid: string,
    state: ConversationState,
    history: StoredMessage[],
    reason: string,
    clientMessage = this.assistant.handoffMessage,
  ): Promise<void> {
    await this.deliver(job, jid, [clientMessage], 'handoff-client');
    state.paused = true;
    this.db.saveConversationState(jid, state);
    await this.setContactLabels(jid, 'HUMANO');
    await this.notifyHuman(job, jid, state, reason, history);
  }

  private async notifyHuman(
    job: QueueJob,
    clientJid: string,
    state: ConversationState,
    reason: string,
    history = this.db.getRecentMessages(
      clientJid,
      this.assistant.maxHistoryMessages,
    ),
  ): Promise<void> {
    if (this.runtime.whatsappProvider === 'meta') {
      this.db.recordDiagnostic(clientJid, 'encaminhamento-interno', `Provedor Meta: ${reason}. A equipe deve abrir a conversa no canal Business; nenhum resumo foi enviado por WhatsApp.`);
      return;
    }
    const target = this.runtime.humanNotifyJid;
    if (!target) {
      this.logger.warn(
        'Set HUMAN_NOTIFY_JID to deliver handoff summaries to the team',
      );
      return;
    }
    if (target === clientJid) {
      this.logger.error('HUMAN_NOTIFY_JID must not be the client conversation');
      return;
    }
    const summary = [
      'Encaminhamento de atendimento inicial',
      'Motivo: ' + reason,
      'Contato: ' + clientJid,
      'Perfil: ' + (state.profileId ?? 'não selecionado'),
      ...Object.entries(state.fields).map(([key, value]) => key + ': ' + value),
      'Campos ainda sem resposta: ' +
        this.missingFields(state).join(', '),
      'Relato recente: ' +
        history
          .filter((message) => message.direction === 'inbound')
          .slice(-5)
          .map((message) => message.body ?? '[áudio sem transcrição]')
          .join(' | ')
          .slice(0, 1200),
    ].join('\n');
    await this.deliver(
      job,
      target,
      [summary],
      'handoff-team-' + reason.toLowerCase().replace(/\s+/g, '-').slice(0, 30),
    );
  }

  private async setContactLabels(jid: string, target: WhatsAppLabelTarget): Promise<void> {
    try {
      await this.contacts.setContactLabels(jid, target);
    } catch {
      this.logger.warn({ target }, 'Falha ao sincronizar as listas nativas do WhatsApp.');
      this.db.recordDiagnostic(jid, 'falha-lista', 'Falha ao sincronizar as listas do WhatsApp.');
      return;
    }
  }

  private async isAuthorized(jid: string): Promise<boolean> {
    try {
      if (this.contacts.getStatus && !(await this.contacts.getStatus()).connected) throw new LabelAuthorizationUnavailableError();
      if (!this.contacts.getContactLabelNames) throw new LabelAuthorizationUnavailableError();
      const names = (await this.contacts.getContactLabelNames(jid)).map((name) => name.trim().toLocaleLowerCase('pt-BR'));
      return names.includes('bot - atendimento') && !names.includes('clientes');
    } catch (error) {
      this.db.recordDiagnostic(jid, 'falha-sincronizacao', 'Não foi possível consultar as listas do WhatsApp; envio bloqueado e mensagem preservada.');
      this.logger.warn('Não foi possível consultar as listas do WhatsApp; envio bloqueado.');
      if (error instanceof LabelAuthorizationUnavailableError) throw error;
      throw new LabelAuthorizationUnavailableError();
    }
  }

  private missingFields(state: ConversationState): string[] {
    const profile = this.assistant.profiles.find(
      (item) => item.id === state.profileId,
    );
    if (!profile) return [];
    return profile.fields
      .filter((field) => field.required && !state.fields[field.id] && this.shouldAsk(field, state))
      .map((field) => field.label);
  }

  private shouldAsk(field: IntakeProfile['fields'][number], state: ConversationState): boolean {
    if (!field.askWhen) return true;
    return normalize(state.fields[field.askWhen.fieldId] ?? '') === normalize(field.askWhen.value);
  }

  private isHumanCommand(text: string): boolean {
    return text
      .split(/\s+/)
      .some(
        (part) =>
          part.replace(/[.!?,:;]/g, '').toLocaleUpperCase('pt-BR') ===
          this.assistant.humanCommand.toLocaleUpperCase('pt-BR'),
      );
  }

  private async deliver(
    job: QueueJob,
    jid: string,
    parts: string[],
    suffix: string,
  ): Promise<void> {
    const split = splitTextDeterministically(parts, this.assistant.maxCharsPerMessage, this.assistant.maxMessagesPerTurn);
    const selected = split.messages;
    if (split.truncated) this.db.recordDiagnostic(jid, 'resposta-limitada', 'O texto configurado excedeu os limites de balões; partes excedentes foram omitidas.');
    const authorizationRequired = jid !== this.runtime.humanNotifyJid;
    if (!selected.length) return;
    for (let index = 0; index < selected.length; index += 1) {
      if (authorizationRequired && !(await this.isAuthorized(jid))) {
        this.db.recordDiagnostic(jid, 'envio-bloqueado', 'A autorização não está confirmada antes do envio.');
        return;
      }
      const id = this.db.queueOutbound(
        job.id + ':' + suffix + ':' + index,
        jid,
        selected[index]!,
        authorizationRequired,
      );
      if (this.db.isOutboundSent(id)) continue;
      if (index > 0) {
        const delay = Math.max(this.assistant.sendPartDelaySeconds, this.assistant.minSecondsBetweenContactMessages);
        if (delay > 0) await delaySeconds(delay);
      }
      if (authorizationRequired && !(await this.isAuthorized(jid))) {
        this.db.markOutboundBlocked(id, 'A autorização mudou antes do envio.');
        this.db.recordDiagnostic(jid, 'envio-bloqueado', 'A autorização mudou antes do próximo balão.');
        return;
      }
      await this.sendOutboxItem({ id, jid, body: selected[index]!, authorizationRequired, attempts: 0 });
    }
  }

  private async flushOutbox(): Promise<void> {
    for (const item of this.db.pendingOutbox()) {
      if (item.authorizationRequired && !(await this.isAuthorized(item.jid))) {
        this.db.markOutboundBlocked(item.id, 'Listas do WhatsApp não confirmadas na retomada da fila.');
        this.db.recordDiagnostic(item.jid, 'envio-bloqueado', 'Uma mensagem pendente foi bloqueada após mudança de autorização.');
        continue;
      }
      await this.sendOutboxItem(item);
    }
  }

  private async sendOutboxItem(item: { id: number; jid: string; body: string; authorizationRequired: boolean; attempts?: number }): Promise<void> {
    if (item.authorizationRequired && !(await this.isAuthorized(item.jid))) {
      this.db.markOutboundBlocked(item.id, 'Listas do WhatsApp não confirmadas antes do envio.');
      return;
    }
    if ((item.attempts ?? 0) >= MAX_JOB_ATTEMPTS) {
      this.db.markOutboundBlocked(item.id, 'Limite de tentativas do envio atingido.');
      this.db.recordDiagnostic(item.jid, 'fila-falha', 'Envio bloqueado após o limite de tentativas; requer revisão humana.');
      return;
    }
    const rateLimit = this.db.outboundLimitReason(item.jid, this.outboundRateLimits(), item.authorizationRequired, item.id);
    if (rateLimit) {
      this.db.markOutboundBlocked(item.id, rateLimit);
      this.db.recordDiagnostic(item.jid, 'limite-envio', rateLimit + ' Mensagem bloqueada para revisão.');
      return;
    }
    await this.prepareTyping(item);
    if (item.authorizationRequired && !(await this.isAuthorized(item.jid))) {
      this.db.markOutboundBlocked(item.id, 'A autorização mudou durante a presença de digitação.');
      this.db.recordDiagnostic(item.jid, 'envio-bloqueado', 'A autorização mudou antes de confirmar o envio.');
      return;
    }
    this.db.markOutboundSending(item.id);
    try {
      await this.sendText(item.jid, item.body);
      this.db.markOutboundSent(item.id);
      this.db.recordDiagnostic(item.jid, 'respondida', 'Mensagem aceita pelo provedor WhatsApp.');
    } catch (error) {
      if (error instanceof SendOutcomeUnknownError) {
        this.db.markOutboundUnknown(item.id, 'O provedor não confirmou o resultado do envio.');
        this.db.recordDiagnostic(item.jid, 'envio-incerto', 'Resultado do envio desconhecido; não haverá repetição automática. Revisão humana necessária.');
        return;
      }
      if (error instanceof ProviderRetryAfterError) {
        this.db.retryOutbound(item.id, error.retryAfterMs, 'O provedor limitou a taxa de envio.');
        this.db.recordDiagnostic(item.jid, 'envio-adiado', 'O provedor limitou a taxa; a mensagem permanece na fila.');
        return;
      }
      const nextAttempt = (item.attempts ?? 0) + 1;
      if (nextAttempt >= MAX_JOB_ATTEMPTS) {
        this.db.markOutboundBlocked(item.id, 'Falha confirmada após o limite de tentativas.');
        this.db.recordDiagnostic(item.jid, 'fila-falha', 'Envio bloqueado após falha confirmada; revisão humana necessária.');
        return;
      }
      this.db.retryOutbound(item.id, Math.min(60_000, 1_000 * 2 ** nextAttempt), safeError(error));
      this.db.recordDiagnostic(item.jid, 'envio-adiado', 'Falha confirmada; nova tentativa limitada foi agendada.');
    }
  }

  private outboundRateLimits(): OutboundRateLimits {
    return {
      perContactDay: this.assistant.maxMessagesPerContactPerDay,
      perContactMonth: this.assistant.maxMessagesPerContactPerMonth,
      globalDay: this.assistant.maxMessagesSentPerDay,
      globalMonth: this.assistant.maxMessagesSentPerMonth,
      minSecondsBetweenContactMessages: this.assistant.minSecondsBetweenContactMessages,
    };
  }

  private async prepareTyping(item: { jid: string; body: string; authorizationRequired: boolean }): Promise<void> {
    if (!item.authorizationRequired || !this.assistant.simulateTyping || !this.contacts.setTyping) return;
    if (!(await this.isAuthorized(item.jid))) return;
    let started = false;
    try {
      await this.contacts.setTyping(item.jid, true);
      started = true;
      const durationSeconds = Math.min(MAX_TYPING_SECONDS, item.body.length * this.assistant.typingSecondsPerCharacter);
      if (durationSeconds > 0) await delaySeconds(durationSeconds);
    } catch (error) {
      this.logger.warn({ error: safeError(error) }, 'Falha ao atualizar presença de digitação; o envio seguirá após nova validação de autorização.');
    } finally {
      if (started) await this.contacts.setTyping(item.jid, false).catch(() => undefined);
    }
  }

}

function containsAny(text: string, keywords: string[]): boolean {
  const normalized = normalize(text);
  return keywords.some((keyword) => normalized.includes(normalize(keyword)));
}

function normalize(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('pt-BR')
    .trim();
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.name : 'UnknownError';
}

export function splitTextDeterministically(parts: string[], maxChars: number, maxMessages: number): { messages: string[]; truncated: boolean } {
  const nonEmpty = parts.map((part) => part.trim()).filter(Boolean);
  const chunks = nonEmpty.map((part) => splitPart(part, maxChars));
  const flattened = chunks.flat();
  if (flattened.length <= maxMessages) return { messages: flattened, truncated: false };

  const finalChunks = chunks.at(-1) ?? [];
  const prefixChunks = chunks.slice(0, -1).flat();
  if (finalChunks.length >= maxMessages) {
    return { messages: finalChunks.slice(0, maxMessages), truncated: true };
  }
  const prefixCount = maxMessages - finalChunks.length;
  return { messages: [...prefixChunks.slice(0, prefixCount), ...finalChunks], truncated: true };
}

function splitPart(text: string, maxChars: number): string[] {
  const sentences = text.match(/[^.!?]+[.!?]+|[^.!?]+$/g) ?? [text];
  const result: string[] = [];
  let current = '';
  for (const rawSentence of sentences) {
    const sentence = rawSentence.trim();
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
    if (candidate.length > maxChars) {
      result.push(current);
      current = sentence;
    } else current = candidate;
  }
  if (current) result.push(current);
  return result;
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

async function delaySeconds(seconds: number): Promise<void> {
  let remaining = seconds * 1000;
  const largestSafeTimer = 2_147_000_000;
  while (remaining > 0) {
    const step = Math.min(remaining, largestSafeTimer);
    await delay(step);
    remaining -= step;
  }
}
