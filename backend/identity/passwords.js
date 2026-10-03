'use strict';

const { argon2, randomBytes, timingSafeEqual } = require('node:crypto');

const PARAMETERS = Object.freeze({ memory: 65536, passes: 3, parallelism: 2, tagLength: 32 });
const MIN_PASSWORD_BYTES = 12;
const MAX_PASSWORD_BYTES = 1024;

function validatePassword(password) {
  if (typeof password !== 'string') throw new TypeError('Senha inválida.');
  const bytes = Buffer.byteLength(password, 'utf8');
  if (bytes < MIN_PASSWORD_BYTES || bytes > MAX_PASSWORD_BYTES || password.includes('\0')) {
    throw new TypeError('A senha deve ter entre 12 e 1024 bytes UTF-8.');
  }
  return password;
}

function argon2id(message, nonce, parameters = PARAMETERS) {
  if (typeof argon2 !== 'function') {
    throw new Error('Identidade exige Node.js 24.7 ou superior com crypto.argon2; operação interrompida.');
  }
  return new Promise((resolve, reject) => {
    argon2('argon2id', { message, nonce, ...parameters }, (error, result) => {
      if (error) reject(new Error('Falha interna ao processar credencial.'));
      else resolve(result);
    });
  });
}

function encodeBase64(value) {
  return Buffer.from(value).toString('base64').replace(/=+$/u, '');
}

async function hashPassword(password) {
  validatePassword(password);
  const salt = randomBytes(16);
  const result = await argon2id(password, salt);
  return `$argon2id$v=19$m=${PARAMETERS.memory},t=${PARAMETERS.passes},p=${PARAMETERS.parallelism}$${encodeBase64(salt)}$${encodeBase64(result)}`;
}

function parsePhc(phc) {
  if (typeof phc !== 'string' || phc.length > 512) return null;
  const match = /^\$argon2id\$v=19\$m=(\d{1,6}),t=(\d{1,2}),p=(\d{1,2})\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/u.exec(phc);
  if (!match) return null;
  const [, memoryText, passesText, parallelismText, saltText, hashText] = match;
  const memory = Number(memoryText);
  const passes = Number(passesText);
  const parallelism = Number(parallelismText);
  const salt = Buffer.from(saltText, 'base64');
  const expected = Buffer.from(hashText, 'base64');
  if (memory < 8192 || memory > 131072 || passes < 1 || passes > 10 || parallelism < 2 || parallelism > 8 ||
      salt.length < 16 || salt.length > 32 || expected.length < 16 || expected.length > 64 ||
      encodeBase64(salt) !== saltText || encodeBase64(expected) !== hashText) return null;
  return { memory, passes, parallelism, salt, expected };
}

async function verifyPassword(phc, password) {
  if (typeof password !== 'string' || Buffer.byteLength(password, 'utf8') > MAX_PASSWORD_BYTES || password.includes('\0')) return false;
  const parsed = parsePhc(phc);
  if (!parsed) return false;
  try {
    const actual = await argon2id(password, parsed.salt, {
      memory: parsed.memory,
      passes: parsed.passes,
      parallelism: parsed.parallelism,
      tagLength: parsed.expected.length
    });
    return actual.length === parsed.expected.length && timingSafeEqual(actual, parsed.expected);
  } catch (_) {
    return false;
  }
}

module.exports = { hashPassword, verifyPassword, validatePassword, parsePhc, PARAMETERS };
