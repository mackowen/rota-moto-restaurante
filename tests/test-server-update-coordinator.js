'use strict';
const assert = require('node:assert/strict');
const Coordinator = require('../server-update-coordinator');
class Channel {
  static channels = new Map();
  constructor(name) { this.name = name; this.listeners = new Set(); if (!Channel.channels.has(name)) Channel.channels.set(name, new Set()); Channel.channels.get(name).add(this); }
  addEventListener(name, listener) { if (name === 'message') this.listeners.add(listener); }
  postMessage(data) { for (const target of Channel.channels.get(this.name) || []) if (target !== this) for (const listener of target.listeners) listener({ data }); }
  close() { Channel.channels.get(this.name)?.delete(this); this.listeners.clear(); }
}
const first = Coordinator.create({ BroadcastChannelImpl: Channel, sourceId: 'first' });
const second = Coordinator.create({ BroadcastChannelImpl: Channel, sourceId: 'second' });
const received = [];
second.subscribe(message => received.push(message));
assert.equal(first.publish('company'), true);
assert.equal(received.length, 1);
assert.equal(received[0].topic, 'company');
assert.equal(Object.hasOwn(received[0], 'payload'), false, 'signals contain no records or credentials');
assert.equal(first.publish('unknown'), false);
assert.equal(Coordinator.acceptedMutation([{ status: 'rejected' }]), false);
assert.equal(Coordinator.acceptedMutation([{ status: 'accepted' }]), true);
first.close(); second.close();
console.log('server update coordinator cross-tab contract: OK');
