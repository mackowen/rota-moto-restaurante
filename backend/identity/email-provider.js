'use strict';

class EmailDeliveryNotConfiguredError extends Error {
  constructor() {
    super('Entrega de email não configurada. Nenhuma operação de conta foi gravada.');
    this.code = 'EMAIL_PROVIDER_NOT_CONFIGURED';
  }
}

function createEmailDeliveryProvider(send) {
  if (typeof send !== 'function') throw new TypeError('O provider de email deve implementar send(message).');
  return Object.freeze({
    async send(message) {
      if (!message || typeof message.to !== 'string' || typeof message.token !== 'string' ||
          !['owner_invitation', 'membership_invitation', 'email_verification', 'password_recovery'].includes(message.kind)) {
        throw new TypeError('Mensagem de identidade inválida.');
      }
      const result = await send(Object.freeze({ ...message }));
      if (result !== true && result?.accepted !== true) throw new Error('Entrega de email não confirmada.');
      return true;
    }
  });
}

function requireEmailProvider(provider) {
  if (!provider || typeof provider.send !== 'function') throw new EmailDeliveryNotConfiguredError();
  return provider;
}

module.exports = { createEmailDeliveryProvider, requireEmailProvider, EmailDeliveryNotConfiguredError };
