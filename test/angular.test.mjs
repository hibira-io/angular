// Runs against whichever Angular is installed: the latest by default, older
// majors in CI's angular job (npm install --no-save @angular/*@<major>).
import 'zone.js';
import '@angular/compiler';
import './dom.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Component,
  Input,
  PLATFORM_ID,
  VERSION,
  createComponent,
  createEnvironmentInjector,
  inject,
  input,
  runInInjectionContext,
  signal,
} from '@angular/core';
import { createApplication } from '@angular/platform-browser';
import {
  HIBIRA,
  injectAgentStream,
  injectChannel,
  injectConnectionState,
  injectEvent,
  injectHibira,
  injectPresence,
  injectPusher,
  injectStream,
  injectTrigger,
  provideHibira,
} from '../index.js';
import { fakePusher, sleep } from './fake-pusher.mjs';

const v = `[angular ${VERSION.full}]`;

async function app(providers) {
  return createApplication({ providers });
}

// An app around a fake client; `fn` runs in a child injector that stop()
// destroys, the way a component or a route's providers would be.
async function setup(fn, pusher = fakePusher(), extra = []) {
  const appRef = await app([provideHibira({ client: pusher }), ...extra]);
  const scope = (f) => {
    const injector = createEnvironmentInjector([], appRef.injector);
    return { out: runInInjectionContext(injector, f), stop: () => injector.destroy() };
  };
  const { out, stop } = scope(fn);
  const flush = async () => {
    for (let i = 0; i < 3; i++) {
      appRef.tick();
      await sleep(0);
    }
  };
  return { out, pusher, appRef, stop, scope, flush };
}

test(`${v} injectChannel shares one subscription and leaves with the last user`, async () => {
  const { out: a, pusher, stop, scope } = await setup(() => injectChannel('private-a'));
  const b = scope(() => injectChannel('private-a'));
  assert.equal(a(), pusher.channel('private-a'));
  assert.equal(a(), b.out());
  assert.equal(pusher.log.filter(([op]) => op === 'subscribe').length, 1);
  stop();
  assert.ok(pusher.channel('private-a'));
  assert.equal(a(), null);
  b.stop();
  assert.equal(pusher.channel('private-a'), undefined);
});

test(`${v} injectChannel follows a signal and a function`, async () => {
  const name = signal('x');
  const { out, pusher, flush, stop, scope } = await setup(() => injectChannel(name));
  await flush();
  assert.equal(out().name, 'x');
  name.set('y');
  await flush();
  assert.equal(out().name, 'y');
  assert.equal(pusher.channel('x'), undefined);
  name.set(null);
  await flush();
  assert.equal(out(), null);
  assert.equal(pusher.channels.size, 0);
  stop();

  const id = signal(1);
  const g = scope(() => injectChannel(() => `private-order-${id()}`));
  await flush();
  assert.equal(g.out().name, 'private-order-1');
  id.set(2);
  await flush();
  assert.equal(g.out().name, 'private-order-2');
  g.stop();
  assert.equal(pusher.channels.size, 0);
});

test(`${v} injectEvent binds at once, follows the event name, unbinds on destroy`, async () => {
  const got = [];
  const event = signal('created');
  const { pusher, stop, flush } = await setup(() => injectEvent('orders', event, (d, m) => got.push([d, m])));
  const ch = pusher.channel('orders');
  await flush();
  ch.emit('created', { id: 1 }, { user_id: 'u' });
  event.set('updated');
  await flush();
  ch.emit('created', { id: 2 });
  ch.emit('updated', { id: 3 });
  assert.deepEqual(got, [
    [{ id: 1 }, { user_id: 'u' }],
    [{ id: 3 }, undefined],
  ]);
  stop();
  assert.equal(ch.count('updated'), 0);
  assert.equal(pusher.channel('orders'), undefined);
});

test(`${v} injectEvent with fixed arguments binds without change detection`, async () => {
  const got = [];
  const { pusher } = await setup(() => injectEvent('orders', 'created', (d) => got.push(d)));
  pusher.channel('orders').emit('created', 1);
  assert.deepEqual(got, [1]);
});

test(`${v} injectEvent takes a channel object (Echo subscription)`, async () => {
  const pusher = fakePusher();
  const ch = pusher.subscribe('private-echo');
  const got = [];
  const { stop } = await setup(() => injectEvent(ch, 'ping', (d) => got.push(d)), pusher);
  ch.emit('ping', 1);
  stop();
  ch.emit('ping', 2);
  assert.deepEqual(got, [1]);
  assert.ok(pusher.channel('private-echo'), 'not unsubscribed');
});

test(`${v} injectEvent's handler may set signals`, async () => {
  const { out, pusher, flush } = await setup(() => {
    const orders = signal([]);
    injectEvent('orders', signal('created'), (o) => orders.update((list) => [o, ...list]));
    return orders;
  });
  await flush();
  pusher.channel('orders').emit('created', { id: 1 });
  assert.deepEqual(out(), [{ id: 1 }]);
});

test(`${v} injectConnectionState`, async () => {
  const { out, pusher, stop } = await setup(() => injectConnectionState());
  assert.equal(out(), 'connecting');
  pusher.setState('connected');
  assert.equal(out(), 'connected');
  stop();
  pusher.setState('unavailable');
  assert.equal(out(), 'connected', 'unbound after destroy');
});

test(`${v} injectPresence`, async () => {
  const { out, pusher } = await setup(() => injectPresence('presence-room'));
  assert.deepEqual(out.members(), []);
  pusher.succeed('presence-room', { a: { name: 'A' }, b: { name: 'B' } }, 'b');
  assert.deepEqual(out.members(), [
    { id: 'b', info: { name: 'B' }, me: true },
    { id: 'a', info: { name: 'A' }, me: false },
  ]);
  assert.equal(out.me().id, 'b');
  pusher.join('presence-room', 'c', { name: 'C' });
  assert.deepEqual(out.others().map((m) => m.id), ['a', 'c']);
  pusher.leave('presence-room', 'a');
  assert.equal(out.count(), 2);
});

test(`${v} injectTrigger`, async () => {
  const { out, pusher } = await setup(() => injectTrigger('private-chat'));
  assert.equal(out('client-typing', { a: 1 }), false);
  pusher.succeed('private-chat');
  assert.equal(out('client-typing', { a: 1 }), true);
  assert.deepEqual(pusher.channel('private-chat').sent, [['client-typing', { a: 1 }]]);
  assert.throws(() => out('typing'), /must start with "client-"/);
});

test(`${v} injectStream`, async () => {
  const { out, pusher } = await setup(() => injectStream('private-ai'));
  const ch = pusher.channel('private-ai');
  assert.equal(out.text(), '');
  ch.emit('ai-stream', { id: 's1', seq: 0, delta: 'Hel', meta: { model: 'm' } });
  ch.emit('ai-stream', { id: 's1', seq: 1, delta: 'lo' });
  assert.equal(out.text(), 'Hello');
  assert.equal(out.done(), false);
  assert.deepEqual(out.stream().meta, { model: 'm' });
  ch.emit('ai-stream', { id: 's1', seq: 2, done: true, error: 'overloaded' });
  assert.equal(out.done(), true);
  assert.equal(out.error(), 'overloaded');
  ch.emit('ai-stream', { id: 's2', seq: 0, delta: 'Next' });
  assert.equal(out.text(), 'Next');
  out.reset();
  assert.equal(out.stream(), null);
});

test(`${v} injectStream with rewind catches up after subscribing`, async () => {
  const { out, pusher } = await setup(() => injectStream('private-ai', { rewind: { seconds: 120 } }));
  assert.equal(out.history(), null);
  const ch = pusher.succeed('private-ai');
  assert.deepEqual(pusher.log.at(-1), ['send_event', 'pusher:rewind', { channel: 'private-ai', seconds: 120 }, 'private-ai']);
  ch.emit('ai-stream', { id: 's1', seq: 1, delta: 'lo' });
  ch.emit('ai-stream', { id: 's1', seq: 0, delta: 'Hel' });
  assert.equal(out.text(), '', 'held until the history answers');
  ch.emit('pusher:rewind_succeeded', { count: 1, window: 3600, complete: true });
  assert.equal(out.text(), 'Hello');
  assert.equal(out.stream().incomplete, false);
  assert.deepEqual(out.history(), { count: 1, window: 3600, complete: true });
});

test(`${v} injectStream with an id signal and a custom event`, async () => {
  const id = signal('mine');
  const { out, pusher } = await setup(() => injectStream('private-ai', { id, event: 'answer' }));
  const ch = pusher.channel('private-ai');
  ch.emit('answer', { id: 'other', seq: 0, delta: 'no' });
  ch.emit('ai-stream', { id: 'mine', seq: 0, delta: 'no' });
  ch.emit('answer', { id: 'mine', seq: 0, delta: 'yes' });
  assert.equal(out.text(), 'yes');
  id.set('other');
  assert.equal(out.stream(), null);
});

test(`${v} injectAgentStream follows Laravel AI events, chunks and rewind`, async () => {
  const invocationId = signal(null);
  const { out, pusher } = await setup(() => injectAgentStream('private-hibira-ai.user.1', { rewind: true, invocationId }));
  assert.equal(out.status(), 'idle');
  const ch = pusher.succeed('private-hibira-ai.user.1');
  assert.equal(pusher.log.at(-1)[1], 'pusher:rewind');
  const e = (id, type, fields) => ({ id, invocation_id: 'inv', type, ...fields });
  ch.emit('stream_start', e('1', 'stream_start', { model: 'm' }));
  ch.emit('text_delta', e('2', 'text_delta', { delta: 'Hi' }));
  ch.emit('pusher:rewind_succeeded', { count: 1, window: 600, complete: true });
  ch.emit('text_delta', e('2', 'text_delta', { delta: 'Hi' }));
  assert.equal(out.text(), 'Hi');
  const json = JSON.stringify(e('3', 'tool_result', { tool_id: 't', result: 'x'.repeat(300), successful: true }));
  ch.emit('hibira:chunk', { id: 'c', event: 'tool_result', index: 1, count: 2, data: json.slice(150) });
  ch.emit('hibira:chunk', { id: 'c', event: 'tool_result', index: 0, count: 2, data: json.slice(0, 150) });
  assert.equal(out.toolCalls()[0].result, 'x'.repeat(300));
  ch.emit('tool_approval_request', e('4', 'tool_approval_request', { approvals: [{ id: 'a' }] }));
  assert.equal(out.status(), 'awaiting_approval');
  assert.deepEqual(out.approvals(), [{ id: 'a' }]);
  invocationId.set('other');
  assert.equal(out.run(), null);
});

test(`${v} the injector option works outside an injection context`, async () => {
  const { appRef, pusher } = await setup(() => null);
  assert.throws(() => injectChannel('c'), /injection context/);
  const ch = injectChannel('c', { injector: appRef.injector });
  assert.equal(ch(), pusher.channel('c'));
  const s = injectStream('c', { injector: appRef.injector });
  assert.equal(s.channel(), ch());
});

test(`${v} in a component: signal inputs, change detection, cleanup on destroy`, async () => {
  const Room = Component({
    selector: 'room-count',
    standalone: true,
    template: '{{ presence.count() }} here, {{ state() }}, {{ stream.text() }}',
  })(
    class Room {
      roomId = input.required();
      room = () => `presence-room-${this.roomId()}`;
      presence = injectPresence(this.room);
      stream = injectStream(this.room);
      state = injectConnectionState();
      hibira = injectHibira();
      pusher = injectPusher();
    },
  );
  // What the Angular CLI's JIT transform adds for a signal input.
  Input({ isSignal: true, alias: 'roomId', required: true, transform: undefined })(Room.prototype, 'roomId');
  const { appRef, pusher, flush } = await setup(() => null);
  const host = document.createElement('div');
  document.body.append(host);
  const ref = createComponent(Room, { environmentInjector: appRef.injector, hostElement: host });
  ref.setInput('roomId', '1');
  appRef.attachView(ref.hostView);
  await flush();
  assert.equal(ref.instance.pusher, pusher);
  assert.equal(ref.instance.hibira, appRef.injector.get(HIBIRA));
  assert.ok(pusher.channel('presence-room-1'));
  assert.equal(pusher.log.filter(([op]) => op === 'subscribe').length, 1, 'one subscription for both');
  pusher.succeed('presence-room-1', { a: {}, b: {} }, 'a');
  pusher.setState('connected');
  pusher.channel('presence-room-1').emit('ai-stream', { id: 's', seq: 0, delta: 'Hi' });
  await flush();
  assert.equal(host.textContent.trim(), '2 here, connected, Hi');

  ref.setInput('roomId', '2');
  await flush();
  assert.equal(pusher.channel('presence-room-1'), undefined);
  assert.ok(pusher.channel('presence-room-2'));

  ref.destroy();
  assert.equal(pusher.channels.size, 0);
});

test(`${v} provideHibira opens pusher-js lazily with Hibira defaults, disconnects on destroy`, async () => {
  const appRef = await app([
    provideHibira({ appKey: 'key', options: { wsHost: '127.0.0.1', wsPort: 9, forceTLS: false, enabledTransports: ['ws'] } }),
  ]);
  const hibira = appRef.injector.get(HIBIRA);
  const pusher = hibira.client;
  assert.equal(pusher.key, 'key');
  assert.equal(pusher.config.cluster, 'hkg');
  assert.equal(pusher.config.wsHost, '127.0.0.1');
  assert.equal(hibira.client, pusher, 'one client');
  appRef.destroy();
  assert.equal(pusher.connection.state, 'disconnected');
});

test(`${v} nothing connects during server rendering`, async () => {
  const appRef = await app([provideHibira({ appKey: 'key' }), { provide: PLATFORM_ID, useValue: 'server' }]);
  const out = runInInjectionContext(appRef.injector, () => ({
    pusher: injectPusher(),
    channel: injectChannel('c'),
    state: injectConnectionState(),
    stream: injectStream('c'),
    presence: injectPresence('presence-c'),
    trigger: injectTrigger('private-c'),
  }));
  assert.equal(out.pusher, null);
  assert.equal(out.channel(), null);
  assert.equal(out.state(), 'initialized');
  assert.equal(out.stream.text(), '');
  assert.deepEqual(out.presence.members(), []);
  assert.equal(out.trigger('client-x'), false);
});

test(`${v} a client function runs in an injection context; a passed-in client is not disconnected`, async () => {
  const pusher = fakePusher();
  const Echo = { connector: { pusher } };
  const appRef = await app([
    { provide: 'echo', useValue: Echo },
    provideHibira({ client: () => inject('echo').connector.pusher }),
  ]);
  assert.equal(appRef.injector.get(HIBIRA).client, pusher);
  appRef.destroy();
  assert.ok(!pusher.log.some(([op]) => op === 'disconnect'));
});

test(`${v} without provideHibira everything stays empty`, async () => {
  const appRef = await app([]);
  const out = runInInjectionContext(appRef.injector, () => ({
    hibira: injectHibira(),
    pusher: injectPusher(),
    channel: injectChannel('c'),
  }));
  assert.equal(out.hibira, null);
  assert.equal(out.pusher, null);
  assert.equal(out.channel(), null);
});
