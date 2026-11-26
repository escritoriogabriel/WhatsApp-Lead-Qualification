export class SendOutcomeUnknownError extends Error {
  constructor() {
    super('O provedor não confirmou se a mensagem foi aceita. A saída foi pausada para revisão.');
    this.name = 'SendOutcomeUnknownError';
  }
}

export class ProviderRetryAfterError extends Error {
  constructor(readonly retryAfterMs: number) {
    super('O provedor solicitou que o envio aguarde antes de tentar novamente.');
    this.name = 'ProviderRetryAfterError';
  }
}
