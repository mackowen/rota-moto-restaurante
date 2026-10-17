'use strict';

const nodemailer = require('nodemailer');
const { createEmailDeliveryProvider } = require('./email-provider');

function createSmtpTransport({ host, port, secure = false, requireTLS = true, user, password }) {
  if (!host || !Number.isInteger(Number(port)) || Number(port) < 1 || Number(port) > 65535 ||
      typeof password !== 'string' || !password || user !== undefined && (typeof user !== 'string' || !user) ||
      (user && !secure && !requireTLS)) throw new Error('Configuração SMTP segura incompleta.');
  return nodemailer.createTransport({ host, port: Number(port), secure: Boolean(secure), requireTLS: Boolean(requireTLS),
    auth: user ? { user, pass: password } : undefined, tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2' },
    disableFileAccess: true, disableUrlAccess: true, connectionTimeout: 8000, greetingTimeout: 8000, socketTimeout: 15000 });
}
async function verifySmtpConnection(options) {
  if (typeof options?.user !== 'string' || !options.user) throw new Error('Verificação SMTP exige autenticação explícita.');
  const transport = createSmtpTransport(options);
  try { await transport.verify(); return true; } finally { transport.close(); }
}
function createSmtpMailProvider({ host, port, secure = false, requireTLS = true, user, password, from, baseUrl }) {
  if (!from || !/^https:\/\//u.test(baseUrl || '')) throw new Error('Envio SMTP exige remetente e URL pública HTTPS.');
  const transport = createSmtpTransport({ host, port, secure, requireTLS, user, password });
  const send = async message => {
    const link = new URL(baseUrl);
    link.hash = new URLSearchParams({ action: message.kind, token: message.token }).toString();
    const subjects = { owner_invitation: 'Convite para o RotaMoto', membership_invitation: 'Convite para o RotaMoto',
      email_verification: 'Confirme seu email no RotaMoto', password_recovery: 'Recuperação de acesso ao RotaMoto',
      mfa_recovery: 'Confirme a solicitação de recuperação de MFA do RotaMoto' };
    const result = await transport.sendMail({ from, to: message.to, subject: subjects[message.kind],
      text: `Use este link para concluir a solicitação: ${link.href}\n\nO link é de uso único e expira conforme a política da instalação.` });
    return result.accepted?.some(address => address.toLowerCase() === message.to.toLowerCase()) === true;
  };
  const provider = createEmailDeliveryProvider(send);
  return Object.freeze({ ...provider, async verify() { await transport.verify(); return true; }, close() { transport.close(); } });
}
module.exports = { createSmtpMailProvider, verifySmtpConnection };
