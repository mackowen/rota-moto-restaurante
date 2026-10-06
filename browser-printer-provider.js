(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.RotaMotoBrowserPrinter = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function print(html, documentRef = globalThis.document, windowRef = globalThis.window) {
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
