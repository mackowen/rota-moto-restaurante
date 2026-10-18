(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.RotaMotoServerUpdateCoordinator = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const TOPICS = new Set(['company', 'team', 'drivers', 'integrations', 'operations', 'reports']);
  const CHANNEL_NAME = 'rotamoto.server-updates.v1';
  const MESSAGE_TYPE = 'rotamoto.server-update.v1';
  function create(options = {}) {
    const BroadcastChannelImpl = options.BroadcastChannelImpl || globalThis.BroadcastChannel;
    let storage = options.storage;
    if (!Object.hasOwn(options, 'storage') && typeof window !== 'undefined') { try { storage = window.localStorage; } catch (_) { storage = null; } }
    const eventTarget = options.eventTarget || globalThis;
    const sourceId = options.sourceId || null;
    const source = sourceId || `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    const listeners = new Set();
    let channel = null;
    let closed = false;
    try { if (typeof BroadcastChannelImpl === 'function') channel = new BroadcastChannelImpl(CHANNEL_NAME); } catch (_) { channel = null; }
    function valid(message) {
      return Boolean(message && message.type === MESSAGE_TYPE && message.source !== source &&
        TOPICS.has(message.topic) && Number.isFinite(message.at) && Math.abs(Date.now() - message.at) < 120000);
    }
    function deliver(message) {
      if (!valid(message)) return;
      for (const listener of listeners) {
        try { listener(Object.freeze({ topic: message.topic, at: message.at })); } catch (_) { /* Isolate view listeners. */ }
      }
    }
    if (channel) channel.addEventListener('message', event => deliver(event?.data));
    const onStorage = event => {
      if (event?.key !== CHANNEL_NAME || typeof event.newValue !== 'string') return;
      try { deliver(JSON.parse(event.newValue)); } catch (_) { /* Ignore malformed signals. */ }
    };
    if (!channel) eventTarget?.addEventListener?.('storage', onStorage);
    return Object.freeze({
      publish(topic) {
        if (closed || !TOPICS.has(topic)) return false;
        const message = Object.freeze({ type: MESSAGE_TYPE, topic, source, at: Date.now() });
        try {
          if (channel) channel.postMessage(message);
          else if (storage) storage.setItem(CHANNEL_NAME, JSON.stringify(message));
          else return false;
          return true;
        } catch (_) { return false; }
      },
      subscribe(listener) {
        if (closed || typeof listener !== 'function') return () => {};
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      close() {
        if (closed) return;
        closed = true; listeners.clear(); channel?.close?.();
        if (!channel) eventTarget?.removeEventListener?.('storage', onStorage);
      }
    });
  }
  function acceptedMutation(results) {
    return Array.isArray(results) && results.some(item => item && ['accepted', 'duplicate'].includes(item.status));
  }
  return Object.freeze({ create, acceptedMutation, topics: Object.freeze([...TOPICS]) });
});
