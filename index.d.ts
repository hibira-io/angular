import type { EnvironmentProviders, InjectionToken, Injector, Signal } from '@angular/core';
import type Pusher from 'pusher-js';
import type { Options } from 'pusher-js';
import type { Member } from './client.js';
import type { HistoryResult, RewindOptions, Stream } from './stream.js';
import type { AgentRun, AgentRunStatus, AgentToolCall } from './agent.js';

export type { Member } from './client.js';
export type { HistoryResult, RewindOptions, Stream, StreamPayload, StreamStore } from './stream.js';
export { HIBIRA_DEFAULTS, hibiraOptions } from './client.js';
export { STREAM_EVENT, createStreamStore, followStream } from './stream.js';
export type { AgentPart, AgentRun, AgentRunStatus, AgentStore, AgentToolCall } from './agent.js';
export { AGENT_EVENTS, CHUNK_EVENT, createAgentStore } from './agent.js';

/** A pusher-js channel (PresenceChannel and PrivateChannel included). */
export type Channel = ReturnType<Pusher['subscribe']>;
/** A value, a signal, or a function (which may read signals). */
export type Source<T> = T | Signal<T> | (() => T);
/** A channel name to subscribe to, a channel to use as is, or null for none. */
export type ChannelTarget = Source<string | Channel | null | undefined>;

export type ConnectionState = 'initialized' | 'connecting' | 'connected' | 'unavailable' | 'failed' | 'disconnected';

/** Every inject*() function takes this to run outside an injection context. */
export interface InjectOptions {
  injector?: Injector;
}

export interface HibiraConfig {
  /** App key from the Hibira portal. */
  appKey?: string;
  /** pusher-js options merged over HIBIRA_DEFAULTS. */
  options?: Partial<Options>;
  /**
   * Use this client instead, or the one this function returns (it runs in an
   * injection context), e.g. `() => inject(EchoService).echo.connector.pusher`.
   * A client you pass is never disconnected for you.
   */
  client?: Pusher | (() => Pusher);
}

export interface Hibira {
  /** The pusher-js client; opened on first use in the browser, null on the server. */
  readonly client: Pusher | null;
  /** Disconnects a client provideHibira() opened (also done when the app is destroyed). */
  disconnect(): void;
}

export const HIBIRA: InjectionToken<Hibira>;

/** Providers for one Hibira connection, for bootstrapApplication() or an NgModule. */
export function provideHibira(config?: HibiraConfig): EnvironmentProviders;

/** The Hibira instance, or null without provideHibira(). */
export function injectHibira(options?: InjectOptions): Hibira | null;

/** The pusher-js client, or null on the server or without provideHibira(). */
export function injectPusher(options?: InjectOptions): Pusher | null;

/** Subscribes until the injection context is destroyed; one subscription per name. */
export function injectChannel(name: Source<string | null | undefined>, options?: InjectOptions): Signal<Channel | null>;

/** Calls handler for each event on the channel; returns the channel signal. */
export function injectEvent<T = any>(
  target: ChannelTarget,
  event: Source<string | null | undefined>,
  handler: (data: T, metadata?: { user_id?: string }) => void,
  options?: InjectOptions,
): Signal<Channel | null>;

export function injectConnectionState(options?: InjectOptions): Signal<ConnectionState>;

export interface Presence<Info = any> {
  channel: Signal<Channel | null>;
  /** You first. */
  members: Signal<Member<Info>[]>;
  others: Signal<Member<Info>[]>;
  me: Signal<Member<Info> | null>;
  count: Signal<number>;
}

export function injectPresence<Info = any>(target: ChannelTarget, options?: InjectOptions): Presence<Info>;

/** Sends a client event ("client-..."); false when not subscribed yet. */
export function injectTrigger(target: ChannelTarget, options?: InjectOptions): (event: `client-${string}`, data?: any) => boolean;

export interface InjectStreamOptions extends InjectOptions {
  /** Default "ai-stream". */
  event?: Source<string | null | undefined>;
  /** Follow only this stream. */
  id?: Source<string | null | undefined>;
  /** Streams kept, default 50. */
  maxStreams?: number;
  /**
   * Catch up from channel history (pusher:rewind) on each subscription, so a
   * reload or a dropped connection does not lose chunks. Needs channel
   * history on for the app (Hobby plans and up).
   */
  rewind?: boolean | RewindOptions;
}

export interface StreamState<Meta = any> {
  channel: Signal<Channel | null>;
  /** The stream with `id`, or else the one that started last. */
  stream: Signal<Stream<Meta> | null>;
  streams: Signal<Record<string, Stream<Meta>>>;
  text: Signal<string>;
  done: Signal<boolean>;
  error: Signal<string | null>;
  /** The last rewind's result, or null before one (or without `rewind`). */
  history: Signal<HistoryResult | null>;
  /** Forget every stream. */
  reset(): void;
}

export function injectStream<Meta = any>(target: ChannelTarget, options?: InjectStreamOptions): StreamState<Meta>;

export interface InjectAgentStreamOptions extends InjectOptions {
  /** Follow only this run (the invocation id of broadcastOnQueue()). */
  invocationId?: Source<string | null | undefined>;
  /** Runs kept, default 20. */
  maxRuns?: number;
  /** Catch up from channel history (pusher:rewind) on each subscription. Hobby plans and up. */
  rewind?: boolean | RewindOptions;
  /** Extra event names to listen to, such as a provider's own error types. */
  events?: string[];
}

export interface AgentStreamState {
  channel: Signal<Channel | null>;
  /** The run with invocationId, or else the one that started last. */
  run: Signal<AgentRun | null>;
  runs: Signal<Record<string, AgentRun>>;
  text: Signal<string>;
  reasoning: Signal<string>;
  /** "idle" before the first event. */
  status: Signal<AgentRunStatus | 'idle'>;
  done: Signal<boolean>;
  error: Signal<string | null>;
  toolCalls: Signal<AgentToolCall[]>;
  approvals: Signal<any[]>;
  history: Signal<HistoryResult | null>;
  /** Forget every run. */
  reset(): void;
}

/** A Laravel AI SDK agent stream (laravel/ai broadcastOnQueue()), put back together. */
export function injectAgentStream(target: ChannelTarget, options?: InjectAgentStreamOptions): AgentStreamState;
