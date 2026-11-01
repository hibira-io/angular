// End-to-end test against a running Hibira (or any Pusher-compatible) server
// with client events enabled. Skipped unless HIBIRA_E2E_KEY is set:
//
//   HIBIRA_E2E_HOST=127.0.0.1 HIBIRA_E2E_PORT=8080 HIBIRA_E2E_TLS=0 \
//   HIBIRA_E2E_APP_ID=... HIBIRA_E2E_KEY=... HIBIRA_E2E_SECRET=... npm run test:e2e
import 'zone.js';
import '@angular/compiler';
import '../dom.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VERSION, createEnvironmentInjector, runInInjectionContext } from '@angular/core';
import { createApplication } from '@angular/platform-browser';
import PusherServer from 'pusher';
import { HIBIRA, injectConnectionState, injectEvent, injectPresence, injectStream, injectTrigger, provideHibira } from '../../index.js';
import { streamToChannel } from '../../server.js';

const v = `[angular ${VERSION.full}]`;

const env = process.env;
const skip = !env.HIBIRA_E2E_KEY && 'set HIBIRA_E2E_KEY to run';
const host = env.HIBIRA_E2E_HOST ?? '127.0.0.1';
const port = Number(env.HIBIRA_E2E_PORT ?? 8080);
const tls = env.HIBIRA_E2E_TLS === '1';

const server = skip
  ? null
  : new PusherServer({ appId: env.HIBIRA_E2E_APP_ID, key: env.HIBIRA_E2E_KEY, secret: env.HIBIRA_E2E_SECRET, host, port: String(port), useTLS: tls });

const options = (userId, name) => ({
  wsHost: host,
  wsPort: port,
  wssPort: port,
  forceTLS: tls,
  enabledTransports: ['ws'],
  channelAuthorization: {
    customHandler: ({ socketId, channelName }, cb) => {
      try {
        const user = channelName.startsWith('presence-') ? { user_id: userId, user_info: { name } } : undefined;
        cb(null, server.authorizeChannel(socketId, channelName, user));
      } catch (err) {
        cb(err, null);
      }
    },
  },
});

// One app per user, each with its own connection; `setup` runs in a child
// injector that unmount() destroys.
async function mount(userId, name, setup) {
  const appRef = await createApplication({ providers: [provideHibira({ appKey: env.HIBIRA_E2E_KEY, options: options(userId, name) })] });
  const injector = createEnvironmentInjector([], appRef.injector);
  const out = runInInjectionContext(injector, setup);
  return { out, hibira: appRef.injector.get(HIBIRA), unmount: () => injector.destroy(), destroy: () => appRef.destroyed || appRef.destroy() };
}

async function waitFor(check, what) {
  const until = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > until) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

test(`${v} inject functions on a real server: presence, client events, streamed text`, { skip }, async () => {
  const room = `presence-e2e-${Date.now()}`;
  const ai = `private-ai-${Date.now()}`;
  const views = {};
  const typing = [];
  const apps = [];

  for (const [id, name] of [
    ['alice', 'Alice'],
    ['bob', 'Bob'],
  ]) {
    apps.push(
      await mount(id, name, () => {
        views[id] = {
          state: injectConnectionState(),
          presence: injectPresence(room),
          trigger: injectTrigger(room),
          stream: injectStream(ai),
        };
        injectEvent(room, 'client-typing', (data, meta) => typing.push([id, data, meta?.user_id]));
      }),
    );
  }
  try {
    await waitFor(() => views.alice.state() === 'connected' && views.bob.state() === 'connected', 'connected');
    await waitFor(() => views.alice.presence.count() === 2 && views.bob.presence.count() === 2, 'both members');
    assert.equal(views.alice.presence.me().id, 'alice');
    assert.deepEqual(views.bob.presence.others().map((m) => m.info.name), ['Alice']);

    assert.equal(views.alice.trigger('client-typing', { on: true }), true);
    await waitFor(() => typing.length === 1, 'client event');
    assert.deepEqual(typing[0], ['bob', { on: true }, 'alice']);

    async function* llm() {
      for (let i = 0; i < 200; i++) {
        await new Promise((r) => setTimeout(r, 2));
        yield { choices: [{ delta: { content: `토큰${i} ` } }] };
      }
    }
    const res = await streamToChannel(server, ai, llm(), { meta: { model: 'test' }, interval: 50 });
    assert.ok(res.events < 30, `${res.events} events for 200 tokens`);
    await waitFor(() => views.alice.stream.done() && views.bob.stream.done(), 'stream done');
    for (const who of ['alice', 'bob']) {
      assert.equal(views[who].stream.text(), res.text);
      assert.deepEqual(views[who].stream.stream().meta, { model: 'test' });
    }

    apps[1].unmount();
    apps[1].destroy();
    await waitFor(() => views.alice.presence.count() === 1, 'bob left');
  } finally {
    for (const a of apps) a.destroy();
  }
});

// Needs channel history on for the app (history: true, history_seconds > 0).
test(`${v} injectStream rewind: a reload mid-answer, then a dropped connection`, { skip: skip || (!env.HIBIRA_E2E_HISTORY && 'set HIBIRA_E2E_HISTORY=1 (app with channel history)') }, async () => {
  const ai = `private-ai-rewind-${Date.now()}`;
  const parts = Array.from({ length: 90 }, (_, i) => `p${i} `);
  const gates = [];
  const waits = [0, 1].map((n) => new Promise((r) => (gates[n] = r)));
  async function* llm() {
    for (let i = 0; i < parts.length; i++) {
      if (i === 30) await waits[0];
      if (i === 60) await waits[1];
      yield parts[i];
    }
  }
  const sending = streamToChannel(server, ai, llm(), { interval: 10 });
  await new Promise((r) => setTimeout(r, 300)); // a third is out before the page loads

  const { out: view, hibira, destroy } = await mount('u', 'U', () => ({ state: injectConnectionState(), s: injectStream(ai, { rewind: true }) }));
  await waitFor(() => view.s.history(), 'rewind answer');
  assert.equal(view.s.history().error, undefined, view.s.history().error);
  const first = parts.slice(0, 30).join('');
  await waitFor(() => view.s.text().length >= first.length, 'first third');
  assert.equal(view.s.text(), first);

  hibira.client.disconnect();
  await waitFor(() => view.state() === 'disconnected', 'disconnected');
  gates[0]();
  await new Promise((r) => setTimeout(r, 500)); // the middle third goes out while offline
  hibira.client.connect();
  const middle = parts.slice(0, 60).join('');
  await waitFor(() => view.s.text().length >= middle.length, 'middle third after reconnect');
  assert.equal(view.s.text(), middle);
  assert.equal(view.s.done(), false);

  gates[1]();
  const res = await sending;
  await waitFor(() => view.s.done(), 'done');
  assert.equal(view.s.text(), res.text);
  assert.equal(view.s.stream().incomplete, false);
  destroy();
});
