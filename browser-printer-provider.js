(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.RotaMotoBrowserPrinter = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  async function waitForImage(image, windowRef) {
    const required = image.alt === 'Código QR da comanda';
    if (image.complete) {
      if (required && Number(image.naturalWidth) === 0) throw new Error('O QR da comanda não foi decodificado.');
      return;
    }
    let timer;
    const readiness = new Promise((resolve, reject) => {
      image.addEventListener('load', resolve, { once: true });
      image.addEventListener('error', () => required ? reject(new Error('O QR da comanda não pôde ser carregado.')) : resolve(), { once: true });
      const setTimer = typeof windowRef.setTimeout === 'function' ? windowRef.setTimeout.bind(windowRef) : setTimeout;
      timer = setTimer(() => required ? reject(new Error('O QR da comanda não ficou pronto para impressão.')) : resolve(), 3000);
    });
    try {
      if (typeof image.decode === 'function') await Promise.race([image.decode(), readiness]);
      else await readiness;
    } catch (error) {
      if (required) throw error;
    } finally {
      const clearTimer = typeof windowRef.clearTimeout === 'function' ? windowRef.clearTimeout.bind(windowRef) : clearTimeout;
      if (timer !== undefined) clearTimer(timer);
    }
  }

  async function print(html, documentRef = globalThis.document, windowRef = globalThis.window) {
    if (!documentRef?.body || typeof windowRef?.print !== 'function') return { ok: false, reason: 'unsupported' };
    let host = documentRef.getElementById('printRoot');
    if (!host) {
      host = documentRef.createElement('main');
      host.id = 'printRoot';
      host.setAttribute('aria-hidden', 'true');
      documentRef.body.appendChild(host);
    }
    host.innerHTML = html;
    try {
      const images = Array.from(host.querySelectorAll?.('img') || []);
      await Promise.all(images.map(image => waitForImage(image, windowRef)));
      if (documentRef.fonts?.ready) await documentRef.fonts.ready.catch(() => undefined);
      await new Promise(resolve => { if (typeof windowRef.requestAnimationFrame === 'function') windowRef.requestAnimationFrame(resolve); else if (typeof windowRef.setTimeout === 'function') windowRef.setTimeout(resolve, 0); else setTimeout(resolve, 0); });
      let cleanupTimer = null;
      if (typeof windowRef.addEventListener === 'function') {
        if (typeof windowRef.setTimeout === 'function') cleanupTimer = windowRef.setTimeout(() => clear(documentRef), 120000);
        windowRef.addEventListener('afterprint', () => {
          if (cleanupTimer !== null && typeof windowRef.clearTimeout === 'function') windowRef.clearTimeout(cleanupTimer);
          clear(documentRef);
        }, { once: true });
      }
      windowRef.print();
      return { ok: true };
    } catch (_) {
      host.replaceChildren();
      return { ok: false, reason: 'blocked' };
    }
  }

  function clear(documentRef = globalThis.document) {
    documentRef?.getElementById('printRoot')?.replaceChildren();
  }

  return Object.freeze({ print, clear });
});
