// Angular signals for pusher-js on Hibira (and Laravel Echo, or any
// Pusher-compatible server): one connection for the app, channels shared
// between components, events, presence members, connection state, client
// events, and injectStream() for LLM output sent with streamToChannel().
//
// Plain functions, no decorators, so the package ships as plain ESM with no
// build step and works from Angular 17 on, with or without zone.js.
//
// The connection opens the first time something injects it, and only in the
// browser: during server rendering injectPusher() returns null and the other
// functions keep their empty values, so SSR and prerendering never connect.
//
// Every inject*() function needs an injection context (a constructor, a field
// initializer, a provider factory) or an `injector` option. What it
// subscribes or binds is released when that context is destroyed.

import {
  DestroyRef,
  InjectionToken,
  Injector,
  PLATFORM_ID,
  assertInInjectionContext,
  computed,
  effect,
  inject,
  makeEnvironmentProviders,
  runInInjectionContext,
  signal,
  untracked,
} from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import Pusher from 'pusher-js';
import { acquireChannel, hibiraOptions, isClientEvent, presenceMembers, releaseChannel } from './client.js';
import { STREAM_EVENT, createStreamStore, followStream, latestStream } from './stream.js';
import { AGENT_EVENTS, createAgentStore, latestRun } from './agent.js';

export { HIBIRA_DEFAULTS, hibiraOptions } from './client.js';
export { STREAM_EVENT, createStreamStore, followStream } from './stream.js';
export { AGENT_EVENTS, CHUNK_EVENT, createAgentStore } from './agent.js';

/** The Hibira instance provideHibira() set up: `inject(HIBIRA)`. */
export const HIBIRA = new InjectionToken('HIBIRA');

/**
 * Providers for one Hibira connection: `bootstrapApplication(App, {
 * providers: [provideHibira({ appKey, options })] })`, or in an NgModule's
 * providers.
 *
 * @param {object} config
 * @param {string} [config.appKey] the app key from the Hibira portal
 * @param {object} [config.options] pusher-js options, merged over HIBIRA_DEFAULTS
 * @param {object|(() => object)} [config.client] an existing pusher-js client
 *   to use instead, or a function returning one; the function runs in an
 *   injection context, so `() => inject(EchoService).echo.connector.pusher`
 *   works. A client you pass is never disconnected for you.
 */
export function provideHibira(config = {}) {
  return makeEnvironmentProviders([{ provide: HIBIRA, useFactory: () => createHibira(config) }]);
}

function createHibira({ appKey, options, client }) {
  const injector = inject(Injector);
  const browser = isPlatformBrowser(inject(PLATFORM_ID));
  let pusher = null;
  const hibira = {
    get client() {
      if (pusher || !browser) return pusher;
      if (client) pusher = typeof client === 'function' ? runInInjectionContext(injector, client) : client;
      else if (appKey) pusher = new Pusher(appKey, hibiraOptions(options));
      return pusher;
    },
    disconnect() {
      if (pusher && !client) pusher.disconnect();
      pusher = null;
    },
  };
  inject(DestroyRef).onDestroy(() => hibira.disconnect());
  return hibira;
}

/** The Hibira instance, or null without provideHibira(). */
export function injectHibira(opts) {
  return run(opts, injectHibira, () => inject(HIBIRA, { optional: true }));
}

/** The pusher-js client, or null on the server or without provideHibira(). */
export function injectPusher(opts) {
  return run(opts, injectPusher, () => inject(HIBIRA, { optional: true })?.client ?? null);
}

/**
 * Subscribes to a channel until the injection context is destroyed. Everything
 * that uses the same name shares one subscription.
 * @param {string|null|import('@angular/core').Signal|(() => string|null)} name
 *   a name, or a signal or function of one; the subscription follows it
 * @returns {import('@angular/core').Signal} the pusher-js channel, or null
 */
export function injectChannel(name, opts) {
  return run(opts, injectChannel, () => {
    const pusher = injectPusher();
    const channel = signal(null);
    const ro = channel.asReadonly();
    if (!isReactive(name)) ro[FIXED] = true;
    follow([name], ([next]) => {
      if (!pusher || !next) return undefined;
      channel.set(acquireChannel(pusher, next));
      return () => {
        channel.set(null);
        releaseChannel(pusher, next);
      };
    });
    return ro;
  });
}

/**
 * Calls handler(data, metadata) for each `event` on a channel. The handler
 * runs outside any reactive context, so it may set signals.
 * @param target channel name, pusher-js channel, or a signal or function of either
 * @param {string|import('@angular/core').Signal|(() => string)} event
 * @returns the channel signal
 */
export function injectEvent(target, event, handler, opts) {
  return run(opts, injectEvent, () => {
    const channel = injectTarget(target);
    follow([channel, event], ([ch, ev]) => {
      if (!ch || !ev) return undefined;
      const fn = (data, metadata) => handler(data, metadata);
      ch.bind(ev, fn);
      return () => ch.unbind(ev, fn);
    });
    return channel;
  });
}

/**
 * The connection state as a signal: "initialized", "connecting",
 * "connected", "unavailable", "failed" or "disconnected".
 */
export function injectConnectionState(opts) {
  return run(opts, injectConnectionState, () => {
    const pusher = injectPusher();
    const state = signal(pusher?.connection.state ?? 'initialized');
    if (pusher) {
      const fn = ({ current }) => state.set(current);
      pusher.connection.bind('state_change', fn);
      inject(DestroyRef).onDestroy(() => pusher.connection.unbind('state_change', fn));
    }
    return state.asReadonly();
  });
}

const PRESENCE_EVENTS = ['pusher:subscription_succeeded', 'pusher:member_added', 'pusher:member_removed'];

/**
 * Members of a presence channel, kept up to date.
 * @returns {{channel, members, others, me, count}} signals; members are
 *   [{ id, info, me }] with you first; info is the user_info your auth signed
 */
export function injectPresence(target, opts) {
  return run(opts, injectPresence, () => {
    const channel = injectTarget(target);
    const members = signal([]);
    follow([channel], ([ch]) => {
      const update = () => members.set(presenceMembers(ch));
      update();
      if (!ch) return undefined;
      for (const ev of PRESENCE_EVENTS) ch.bind(ev, update);
      return () => {
        for (const ev of PRESENCE_EVENTS) ch.unbind(ev, update);
        members.set([]);
      };
    });
    return {
      channel,
      members: members.asReadonly(),
      others: computed(() => members().filter((m) => !m.me)),
      me: computed(() => members().find((m) => m.me) ?? null),
      count: computed(() => members().length),
    };
  });
}

/**
 * A function that sends a client event on a private or presence channel:
 * `trigger('client-typing', { at: Date.now() })`. Returns false when the
 * channel is not subscribed yet. Turn on client events for the app first.
 */
export function injectTrigger(target, opts) {
  return run(opts, injectTrigger, () => {
    const channel = injectTarget(target);
    return (event, data) => {
      if (!isClientEvent(event)) throw new Error(`injectTrigger: "${event}" must start with "client-"`);
      const ch = untracked(channel);
      if (!ch || !ch.subscribed) return false;
      return ch.trigger(event, data ?? {});
    };
  });
}

/**
 * Text streamed to a channel with streamToChannel(), put back together.
 *
 * @param target channel name, pusher-js channel, or a signal or function of either
 * @param {object} [options]
 * @param {string} [options.event="ai-stream"] event name
 * @param {string|import('@angular/core').Signal|(() => string)} [options.id] follow only this stream id
 * @param {number} [options.maxStreams=50] streams kept, oldest dropped first
 * @param {boolean|object} [options.rewind] catch up from channel history on
 *   each subscription: true, or { seconds = 300, limit, timeout = 5000 }
 * @param {import('@angular/core').Injector} [options.injector]
 * @returns {{stream, streams, text, done, error, history, reset, channel}} signals;
 *   `stream` is the one with `id`, or else the one that started last
 */
export function injectStream(target, { event = STREAM_EVENT, id, maxStreams = 50, rewind, injector } = {}) {
  return run({ injector }, injectStream, () => {
    const pusher = injectPusher();
    const channel = injectTarget(target);
    const streams = signal({});
    const history = signal(null);
    const store = createStreamStore((next) => streams.set(next), { maxStreams });
    follow([channel, event], ([ch, ev]) => {
      if (!ch || !ev) return undefined;
      return followStream(ch, {
        event: ev,
        client: ch.pusher ?? pusher,
        rewind,
        onHistory: (result) => history.set(result),
        apply: (payload) => {
          const want = untracked(() => read(id));
          if (want != null && String(payload?.id) !== String(want)) return;
          store.apply(payload);
        },
      });
    });
    const stream = computed(() => {
      const want = read(id);
      const all = streams();
      return want != null ? all[String(want)] ?? null : latestStream(all);
    });
    return {
      channel,
      stream,
      streams: streams.asReadonly(),
      text: computed(() => stream()?.text ?? ''),
      done: computed(() => stream()?.done ?? false),
      error: computed(() => stream()?.error ?? null),
      history: history.asReadonly(),
      reset: store.reset,
    };
  });
}

/**
 * A Laravel AI SDK agent's stream (laravel/ai broadcastOnQueue(), broadcast()
 * or broadcastNow()), put back together: text, reasoning, tool calls and
 * approvals. Events hibira-io/laravel split into chunks are joined.
 *
 * @param target channel name, pusher-js channel, or a signal or function of
 *   either, e.g. `private-hibira-ai.user.${user.id}` (AgentChannel::user())
 * @param {object} [options]
 * @param {string|import('@angular/core').Signal|(() => string)} [options.invocationId] follow only this run
 * @param {number} [options.maxRuns=20] runs kept, oldest dropped first
 * @param {boolean|object} [options.rewind] catch up from channel history on
 *   each subscription: true, or { seconds = 300, limit, timeout = 5000 }
 * @param {string[]} [options.events] extra event names to listen to
 * @param {import('@angular/core').Injector} [options.injector]
 * @returns {{run, runs, text, reasoning, status, done, error, toolCalls, approvals, history, reset, channel}} signals;
 *   `run` is the one with `invocationId`, or else the one that started last
 */
export function injectAgentStream(target, { invocationId, maxRuns = 20, rewind, events, injector } = {}) {
  return run({ injector }, injectAgentStream, () => {
    const pusher = injectPusher();
    const channel = injectTarget(target);
    const runs = signal({});
    const history = signal(null);
    const store = createAgentStore((next) => runs.set(next), { maxRuns });
    follow([channel], ([ch]) => {
      if (!ch) return undefined;
      return followStream(ch, {
        event: events?.length ? [...AGENT_EVENTS, ...events] : AGENT_EVENTS,
        client: ch.pusher ?? pusher,
        rewind,
        onHistory: (result) => history.set(result),
        apply: (payload, name) => store.apply(payload, name),
      });
    });
    const current = computed(() => {
      const want = read(invocationId);
      const all = runs();
      return want != null ? all[String(want)] ?? null : latestRun(all);
    });
    return {
      channel,
      run: current,
      runs: runs.asReadonly(),
      text: computed(() => current()?.text ?? ''),
      reasoning: computed(() => current()?.reasoning ?? ''),
      status: computed(() => current()?.status ?? 'idle'),
      done: computed(() => current()?.done ?? false),
      error: computed(() => current()?.error ?? null),
      toolCalls: computed(() => current()?.toolCalls ?? EMPTY),
      approvals: computed(() => current()?.approvals ?? EMPTY),
      history: history.asReadonly(),
      reset: store.reset,
    };
  });
}

const EMPTY = Object.freeze([]);

// Runs fn in opts.injector's context, or checks that we are in one.
function run(opts, caller, fn) {
  if (opts?.injector) return runInInjectionContext(opts.injector, fn);
  assertInInjectionContext(caller);
  return fn();
}

// Marks a channel signal whose channel never changes (a fixed name), so what
// follows it can bind at once instead of from an effect.
const FIXED = Symbol('hibira.fixed');

// A signal or a function is read (and tracked); anything else is a value.
function isReactive(source) {
  return typeof source === 'function' && !source[FIXED];
}

function read(source) {
  return typeof source === 'function' ? source() : source;
}

// A channel name subscribes; a channel object (Echo's .subscription, a
// channel from injectChannel) is used as is.
function isChannel(value) {
  return value != null && typeof value === 'object' && typeof value.bind === 'function';
}

// A signal of the channel for a name, a channel, or a signal/function of either.
function injectTarget(target) {
  if (!isReactive(target)) {
    if (!isChannel(target)) return injectChannel(target);
    const fixed = signal(target).asReadonly();
    fixed[FIXED] = true;
    return fixed;
  }
  const named = injectChannel(() => {
    const t = target();
    return isChannel(t) ? null : t;
  });
  return computed(() => {
    const t = target();
    return isChannel(t) ? t : named();
  });
}

// Calls setup(values) now when every source is a plain value, or else from an
// effect each time a value changes; the cleanup setup returned runs before
// the next call and when the injection context is destroyed. setup runs
// untracked, so it may set signals (Angular 17 and 18 forbid that in effects).
//
// Reactive sources are first read in the effect, not here: a component's
// input signals have no value until its first change detection.
function follow(sources, setup) {
  const destroyRef = inject(DestroyRef);
  let last = null;
  let cleanup = null;
  const apply = (values) => {
    if (last && values.every((v, i) => Object.is(v, last[i]))) return;
    last = values;
    untracked(() => {
      cleanup?.();
      cleanup = setup(values) ?? null;
    });
  };
  if (sources.some(isReactive)) {
    const ref = effect(() => apply(sources.map(read)), { injector: inject(Injector) });
    destroyRef.onDestroy(() => ref.destroy());
  } else {
    apply(untracked(() => sources.map(read)));
  }
  destroyRef.onDestroy(() => {
    cleanup?.();
    cleanup = null;
  });
}

