'use strict';

const nodemailer = require('nodemailer');
const dns = require('node:dns').promises;
const net = require('node:net');
const { createEmailDeliveryProvider } = require('./email-provider');

function isPublicV4(address) {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some(value => !Number.isInteger(value) || value < 0 || value > 255)) return false;
  const [a,b,c] = parts;
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 ||
    a === 192 && (b === 168 || b === 0 && c <= 2 || b === 88 && c === 99) ||
    a === 198 && (b === 18 || b === 19 || b === 51 && c === 100) || a === 203 && b === 0 && c === 113 ||
    a === 100 && b >= 64 && b <= 127);
}
async function resolvePublicSmtpAddresses(host) {
  if (typeof host !== 'string' || !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/iu.test(host) ||
      host.toLowerCase() === 'localhost' || host.toLowerCase().endsWith('.localhost'))
    throw Object.assign(new Error('O host SMTP precisa ser um domínio DNS público.'), { code: 'SMTP_CONFIGURATION_INVALID' });
  let answers;
  try { answers = await dns.lookup(host, { all: true, family: 4, verbatim: true }); }
  catch (_) { throw Object.assign(new Error('Não foi possível resolver o host SMTP.'), { code: 'SMTP_CONFIGURATION_INVALID' }); }
  if (!answers.length || answers.some(answer => !isPublicV4(answer.address)))
    throw Object.assign(new Error('O host SMTP resolve para uma rede não permitida.'), { code: 'SMTP_CONFIGURATION_INVALID' });
  return answers.map(answer => answer.address);
}

function createSmtpTransport({ host, port, secure = false, requireTLS = true, user, password,
  resolveAddresses = resolvePublicSmtpAddresses }) {
  if (!host || !Number.isInteger(Number(port)) || Number(port) < 1 || Number(port) > 65535 ||
      typeof password !== 'string' || !password || user !== undefined && (typeof user !== 'string' || !user) ||
      (user && !secure && !requireTLS)) throw new Error('Configuração SMTP segura incompleta.');
  return nodemailer.createTransport({ host, port: Number(port), secure: Boolean(secure), requireTLS: Boolean(requireTLS),
    auth: user ? { user, pass: password } : undefined, tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2' },
    getSocket(options, callback) {
      Promise.resolve(resolveAddresses(options.host)).then(addresses => {
        if (!Array.isArray(addresses) || !addresses.length || addresses.some(address => !isPublicV4(address) && resolveAddresses === resolvePublicSmtpAddresses))
          throw new Error('SMTP host resolves to a prohibited network.');
        const address = addresses[cryptoIndex++ % addresses.length];
        const socket = net.connect({ host: address, port: Number(options.port) });
        let complete = false;
        socket.once('connect', () => { if (complete) return; complete = true; callback(null, { connection: socket }); });
        socket.once('error', error => { if (complete) return; complete = true; callback(error); });
      }).catch(callback);
    },
    disableFileAccess: true, disableUrlAccess: true, connectionTimeout: 8000, greetingTimeout: 8000, socketTimeout: 15000 });
}
let cryptoIndex = 0;
async function verifySmtpConnection(options) {
  if (typeof options?.user !== 'string' || !options.user) throw new Error('Verificação SMTP exige autenticação explícita.');
  const transport = createSmtpTransport(options);
  try { await transport.verify(); return true; } finally { transport.close(); }
}
function createSmtpMailProvider({ host, port, secure = false, requireTLS = true, user, password, from, baseUrl, resolveAddresses }) {
  if (!from || !/^https:\/\//u.test(baseUrl || '')) throw new Error('Envio SMTP exige remetente e URL pública HTTPS.');
  const transport = createSmtpTransport({ host, port, secure, requireTLS, user, password, ...(resolveAddresses ? { resolveAddresses } : {}) });
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
module.exports = { createSmtpTransport, createSmtpMailProvider, verifySmtpConnection, resolvePublicSmtpAddresses, isPublicV4 };
