'use strict';

const nodemailer = require('nodemailer');
const { createEmailDeliveryProvider } = require('./email-provider');

function createSmtpMailProvider({ host, port, secure = false, requireTLS = true, user, password, from, baseUrl }) {
  if (!host || !Number.isInteger(Number(port)) || Number(port) < 1 || Number(port) > 65535 ||
      !from || !/^https:\/\//u.test(baseUrl || '') || typeof password !== 'string' || !password ||
      (user && !secure && !requireTLS)) throw new Error('Configuração SMTP segura incompleta.');
  const transport = nodemailer.createTransport({ host, port: Number(port), secure: Boolean(secure), requireTLS: Boolean(requireTLS),
    auth: user ? { user, pass: password } : undefined, tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2' },
    disableFileAccess: true, disableUrlAccess: true, connectionTimeout: 8000, greetingTimeout: 8000, socketTimeout: 15000 });
  const send = async message => {
    const link = new URL('/identity/complete', baseUrl);
    link.searchParams.set('token', message.token);
    const subjects = { owner_invitation: 'Convite para o RotaMoto', membership_invitation: 'Convite para o RotaMoto',
      email_verification: 'Confirme seu email no RotaMoto', password_recovery: 'Recuperação de acesso ao RotaMoto' };
    const result = await transport.sendMail({ from, to: message.to, subject: subjects[message.kind],
      text: `Use este link para concluir a solicitação: ${link.href}\n\nO link é de uso único e expira conforme a política da instalação.` });
    return result.accepted?.some(address => address.toLowerCase() === message.to.toLowerCase()) === true;
  };
  const provider = createEmailDeliveryProvider(send);
  return Object.freeze({ ...provider, async verify() { await transport.verify(); return true; }, close() { transport.close(); } });
}
module.exports = { createSmtpMailProvider };
