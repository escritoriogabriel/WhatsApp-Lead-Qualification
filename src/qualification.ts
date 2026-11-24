import { unlink } from 'node:fs/promises';
import type { Logger } from 'pino';
import type { AssistantConfig, IntakeProfile, RuntimeConfig } from './config.js';
import {
  AgentDatabase,
  type ContactAssignment,
  type ConversationState,
  type QueueJob,
  type StoredMessage,
} from './database.js';
import { GroqProvider } from './groq.js';

const MAX_JOB_ATTEMPTS = 5;

export interface TextSender {
  (jid: string, text: string): Promise<void>;
}

export interface ContactManager {
  setContactAssignment(jid: string, assignment: ContactAssignment): Promise<void>;
  renameContact(jid: string, name: string): Promise<void>;
}

export class QualificationWorker {
  constructor(
    private readonly db: AgentDatabase,
    private readonly provider: GroqProvider,
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
    while (!signal.aborted) {
      try {
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
      await this.processConversation(job);
      this.db.completeJob(job.id);
      this.db.recordDiagnostic(job.jid, 'processada', `Tarefa ${job.id} concluída`);
    } catch (error) {
      const failure = safeError(error);
      const exhausted = this.db.retryJob(
        job.id,
        job.attempts,
        failure,
        MAX_JOB_ATTEMPTS,
      );
      this.logger.error(
        { jid: job.jid, jobId: job.id, attempts: job.attempts, error: failure },
        exhausted ? 'Conversation job exhausted retries' : 'Conversation job will retry',
      );
      this.db.recordDiagnostic(job.jid, 'falha', `Tarefa ${job.id}: ${failure}`);

      if (exhausted) {
        const state = this.db.getConversationState(job.jid);
        state.paused = true;
        this.db.saveConversationState(job.jid, state);
        await this.assignContact(job.jid, 'HUMANO', 'processing-failure');
        await this.deliver(
          job,
          job.jid,
          [this.assistant.handoffMessage],
          'retry-handoff-client',
        );
        await this.notifyHuman(job, job.jid, state, 'Falha repetida no processamento');
        this.db.markMessagesProcessed(
          this.db.getUnprocessedMessages(job.jid).map((message) => message.id),
        );
      }
    }
  }

  private async processConversation(job: QueueJob): Promise<void> {
    const incoming = this.db.getUnprocessedMessages(job.jid);
    if (incoming.length === 0) return;

    const state = this.db.getConversationState(job.jid);
    const assignment = this.db.getContactAssignment(job.jid);
    if (assignment !== 'BOT') {
      await this.removeTemporaryMedia(incoming);
      this.db.markMessagesProcessed(incoming.map((message) => message.id));
      this.db.recordDiagnostic(job.jid, 'ignorada', `Contato fora da lista Bot - atendimento (atribuição local: ${assignment ?? 'desconhecida'})`);
      this.logger.info({ jid: job.jid, assignment }, 'Mensagem ignorada: contato fora da lista Bot - atendimento');
      return;
    }
    if (this.assistant.newContactsOnly && state.profileId === null && !this.db.isFirstContact(job.jid) && !this.db.hasExplicitBotAssignment(job.jid)) {
      await this.removeTemporaryMedia(incoming);
      this.db.markMessagesProcessed(incoming.map((message) => message.id));
      this.db.recordDiagnostic(job.jid, 'ignorada', 'Regra de somente novos contatos; mova o contato para Bot - atendimento no painel ou WhatsApp para reativar');
      return;
    }
    if (state.paused) {
      await this.removeTemporaryMedia(incoming);
      this.db.markMessagesProcessed(incoming.map((message) => message.id));
      this.db.recordDiagnostic(job.jid, 'ignorada', 'Conversa pausada; mova o contato para a lista Bot - atendimento para reativar');
      this.logger.info({ jid: job.jid }, 'Mensagem ignorada: conversa fora da lista Bot - atendimento');
      return;
    }

    let audioFailed = false;
    for (const message of incoming) {
      if (message.kind !== 'audio') continue;
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
      await this.deliver(
        job,
        job.jid,
        [this.assistant.audioRetryMessage],
        'audio-retry',
      );
      this.db.markMessagesProcessed(incoming.map((message) => message.id));
      return;
    }

    const history = this.db.getRecentMessages(
      job.jid,
      this.assistant.maxHistoryMessages,
    );
    const userText = incoming
      .map((message) => message.body ?? '')
      .join(' ')
      .trim();

    if (this.isHumanCommand(userText)) {
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
      state.paused = true;
      this.db.saveConversationState(job.jid, state);
      await this.assignContact(job.jid, 'HUMANO', 'urgency');
      await this.notifyHuman(job, job.jid, state, 'Palavra de urgência detectada');
      this.db.markMessagesProcessed(incoming.map((message) => message.id));
      return;
    }

    const firstTurn =
      state.profileId === null &&
      state.pendingFieldId === null &&
      Object.keys(state.fields).length === 0;
    const profile = this.chooseProfile(userText, state);
    state.profileId = profile.id;
    const extraction = await this.provider.extract(
      profile,
      history,
      state.fields,
      this.assistant,
    );
    if (this.db.getContactAssignment(job.jid) !== 'BOT') {
      await this.removeTemporaryMedia(incoming);
      this.db.markMessagesProcessed(incoming.map((message) => message.id));
      this.db.recordDiagnostic(job.jid, 'ignorada', 'A atribuição mudou durante o processamento');
      return;
    }
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
      state.pendingFieldId = null;
      state.completed = true;
      state.paused = true;
      this.db.saveConversationState(job.jid, state);
      await this.assignContact(job.jid, 'HUMANO', 'completion');
      await this.deliver(
        job,
        job.jid,
        [this.assistant.completionMessage],
        'completion-client',
      );
      await this.notifyHuman(job, job.jid, state, 'Triagem concluída');
    } else {
      const areaUnknown = firstTurn && !state.fields[this.assistant.areaFieldId];
      const askedField = areaUnknown
        ? profile.fields.find((field) => field.id === this.assistant.areaFieldId) ?? nextField
        : nextField;
      state.pendingFieldId = askedField.id;
      this.db.saveConversationState(job.jid, state);
      const parts = firstTurn
        ? [this.assistant.greeting, areaUnknown ? this.assistant.areaQuestion : nextField.question]
        : [extraction.acknowledgement, nextField.question].filter(
            (part): part is string => Boolean(part),
          );
      await this.deliver(
        job,
        job.jid,
        parts.slice(0, this.assistant.maxMessagesPerTurn),
        'qualification-' + nextField.id,
      );
    }

    this.db.markMessagesProcessed(incoming.map((message) => message.id));
  }

  private chooseProfile(
    text: string,
    state: ConversationState,
  ): IntakeProfile {
    const existing = this.assistant.profiles.find(
      (profile) => profile.id === state.profileId,
    );
    if (existing) return existing;
    const normalized = normalize(text);
    const matched = this.assistant.profiles.find((profile) =>
      profile.triggers.some((trigger) => normalized.includes(normalize(trigger))),
    );
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
  ): Promise<void> {
    state.paused = true;
    this.db.saveConversationState(jid, state);
    await this.assignContact(jid, 'HUMANO', 'handoff');
    await this.deliver(job, jid, [this.assistant.handoffMessage], 'handoff-client');
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
    const target = this.runtime.humanNotifyJid;
    if (!target) {
      this.logger.warn(
        { jid: clientJid },
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

  private async assignContact(jid: string, assignment: ContactAssignment, source: string): Promise<void> {
    try {
      await this.contacts.setContactAssignment(jid, assignment);
    } catch (error) {
      const message = safeError(error);
      this.logger.warn({ jid, assignment, error: message }, 'Atribuição local aplicada; falha ao sincronizar lista do WhatsApp');
      this.db.recordDiagnostic(jid, 'falha-lista', message);
    }
    this.db.setContactAssignment(jid, assignment, source);
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
    const messages = parts.filter((part) => part.trim().length > 0);
    const maxMessages = this.assistant.maxMessagesPerTurn;
    const selected = messages.length <= maxMessages
      ? messages
      : [...messages.slice(0, maxMessages - 1), messages.slice(maxMessages - 1).join('\n\n')];
    for (let index = 0; index < selected.length; index += 1) {
      if (suffix.startsWith('qualification-') && this.db.getContactAssignment(jid) !== 'BOT') {
        this.db.recordDiagnostic(jid, 'ignorada', 'A atribuição mudou antes do envio');
        return;
      }
      if (index > 0 && this.assistant.sendPartDelaySeconds > 0) {
        await delaySeconds(this.assistant.sendPartDelaySeconds);
      }
      const id = this.db.queueOutbound(
        job.id + ':' + suffix + ':' + index,
        jid,
        selected[index]!,
      );
      if (this.db.isOutboundSent(id)) continue;
      await this.sendText(jid, selected[index]!);
      this.db.markOutboundSent(id);
      this.db.recordDiagnostic(jid, 'respondida', `Mensagem ${index + 1}/${selected.length}`);
    }
  }

  private async flushOutbox(): Promise<void> {
    for (const item of this.db.pendingOutbox()) {
      await this.sendText(item.jid, item.body);
      this.db.markOutboundSent(item.id);
    }
  }

  private async removeTemporaryMedia(messages: StoredMessage[]): Promise<void> {
    for (const message of messages) {
      if (message.mediaPath) await unlink(message.mediaPath).catch(() => undefined);
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
  return error instanceof Error ? error.message : 'Unknown processing error';
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
