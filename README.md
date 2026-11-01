# @hibira-io/angular

[![npm](https://img.shields.io/npm/v/@hibira-io/angular)](https://www.npmjs.com/package/@hibira-io/angular)
[![ci](https://github.com/hibira-io/angular/actions/workflows/ci.yml/badge.svg)](https://github.com/hibira-io/angular/actions/workflows/ci.yml)

Angular signals for [pusher-js](https://github.com/pusher/pusher-js) on
[Hibira](https://hibira.io), or any Pusher-compatible server: one connection
for the app, channels shared between components, events, presence members,
connection state and client events, each as a signal. It also streams LLM
output to the browser: `streamToChannel()` sends tokens from your backend in
batched events, and `injectStream()` puts them back together, for every tab
and every person on the channel at once.

- Angular 17 and later, standalone or NgModule apps, with or without zone.js.
- Server rendering and prerendering safe: nothing connects on the server.
- Channel names can be signals or functions (component inputs included);
  the subscription follows them.
- Works with Laravel Echo: hand it `echo.connector.pusher`.
- Plain ESM with TypeScript types, no build step, no dependencies besides
  `pusher-js`.

Using React or Vue? See [@hibira-io/react](https://github.com/hibira-io/react)
and [@hibira-io/vue](https://github.com/hibira-io/vue).

## Install

```sh
npm install @hibira-io/angular pusher-js
```

pusher-js is CommonJS, so the Angular CLI prints a warning about it. To
silence it, add it to `allowedCommonJsDependencies` in `angular.json`:

```json
"options": { "allowedCommonJsDependencies": ["pusher-js"] }
```

## Setup

The app key is in the Hibira portal; it is public.

```ts
// app.config.ts
import { ApplicationConfig } from '@angular/core';
import { provideHibira } from '@hibira-io/angular';
import { environment } from '../environments/environment';

export const appConfig: ApplicationConfig = {
  providers: [
    provideHibira({
      appKey: environment.hibiraKey,
      options: { channelAuthorization: { endpoint: '/api/hibira/auth', transport: 'ajax' } },
    }),
  ],
};
```

In an NgModule app, put `provideHibira(...)` in the root module's
`providers`.

`options` are [pusher-js options](https://github.com/pusher/pusher-js#configuration),
merged over the Hibira defaults (`wsHost: 'ws.hibira.io'`, `forceTLS`, and the
`cluster` pusher-js insists on). For a local server set `wsHost`, `wsPort` and
`forceTLS: false`. The connection opens the first time something injects
it, and closes when the app is destroyed.

With Laravel Echo, reuse its connection. The function runs in an injection
context, so it can inject your own service:

```ts
provideHibira({ client: () => inject(EchoService).echo.connector.pusher })
```

## Inject functions

Call them where `inject()` works: a field initializer, a constructor, a
provider factory. What they subscribe and bind is released when the
component (or service, or route injector) is destroyed. Everything they
return is a signal.

```ts
import { Component, input, signal } from '@angular/core';
import { injectConnectionState, injectEvent, injectPresence, injectTrigger } from '@hibira-io/angular';

@Component({
  selector: 'app-room',
  template: `
    <span [class]="state()"></span> {{ presence.count() }} here
    @for (m of presence.others(); track m.id) { <span>{{ m.info?.name }}</span> }
    <input (input)="trigger('client-typing', {})" />
  `,
})
export class Room {
  roomId = input.required<string>();
  orders = signal<Order[]>([]);

  room = () => `presence-room-${this.roomId()}`; // follows the input
  presence = injectPresence<{ name: string }>(this.room);
  trigger = injectTrigger(this.room);
  state = injectConnectionState(); // 'connecting' | 'connected' | 'unavailable' | ...

  constructor() {
    injectEvent<Order>('orders', 'order.created', (order) => this.orders.update((list) => [order, ...list]));
    injectEvent(this.room, 'client-typing', (data, meta) => this.showTyping(meta?.user_id));
  }
}
```

| Function | Returns |
| --- | --- |
| `provideHibira(config)` | the providers; `inject(HIBIRA)` gives `{ client, disconnect() }` |
| `injectPusher()` | the pusher-js client, or `null` on the server |
| `injectChannel(name)` | a signal of the channel; subscribed until destroyed, shared by everything using the same name; `null` subscribes to nothing |
| `injectEvent(channel, event, handler)` | the channel signal; calls `handler(data, metadata)` |
| `injectPresence(channel)` | signals `{ members, others, me, count, channel }`; members are `{ id, info, me }`, you first; `info` is the `user_info` your auth endpoint signed |
| `injectTrigger(channel)` | `trigger('client-…', data)`, `false` until subscribed; turn on client events for the app in the portal |
| `injectConnectionState()` | a signal: `'initialized'`, `'connecting'`, `'connected'`, `'unavailable'`, `'failed'` or `'disconnected'` |
| `injectStream(channel, { id, event, rewind })` | signals `{ text, done, error, stream, streams, history }` and `reset()`, see below |
| `injectAgentStream(channel, { invocationId, rewind })` | signals `{ text, reasoning, status, done, error, toolCalls, approvals, run, runs, history }` and `reset()` for Laravel AI SDK agents, see below |

Wherever a function takes a channel, pass a name (it subscribes), a channel
object you already have (Echo's `Echo.private('x').subscription`), or a
signal or function of either. A plain name binds at once; a signal or
function is read in an effect, so it follows changes and may read component
inputs, and binds on the first change detection.

Outside an injection context, pass the injector as the last argument:
`injectStream(name, { injector })`, `injectChannel(name, { injector })`.

Handlers run outside any reactive context, so setting signals in them is
fine. With zone.js they run in Angular's zone; without it, the signals they
set schedule change detection.

## Auth endpoint

Private and presence channels need a route on your backend that checks who
is signed in and signs the subscription. `endpoint` in `channelAuthorization`
points to it. With Express (Angular SSR's `server.ts` is an Express app):

```ts
import express from 'express';
import Pusher from 'pusher';

const pusher = new Pusher({
  appId: process.env['HIBIRA_APP_ID']!,
  key: process.env['HIBIRA_KEY']!,
  secret: process.env['HIBIRA_SECRET']!,
  host: 'ws.hibira.io', // the host shown on your app page
  useTLS: true,
});

app.post('/api/hibira/auth', express.urlencoded({ extended: false }), (req, res) => {
  const user = req.user; // your session check
  if (!user) return res.sendStatus(401);
  const { socket_id, channel_name } = req.body;
  if (!mayJoin(user, channel_name)) return res.sendStatus(403);
  const presence = channel_name.startsWith('presence-')
    ? { user_id: String(user.id), user_info: { name: user.name } }
    : undefined;
  res.json(pusher.authorizeChannel(socket_id, channel_name, presence));
});
```

The app ID and key are on the app's page in the Hibira portal; the secret
is shown only once, when you create the app, so store it in your backend's
environment then. On the Free plan, add your site's origin (for example
`http://localhost:4200`) to the app's allowed origins, or browsers can't
connect.

## Streaming LLM output

Send the model's stream from your backend with `streamToChannel()`. It
takes the stream of the Anthropic, OpenAI and Gemini SDKs and the Vercel AI
SDK as they are, an async iterable of strings, or a `ReadableStream`.

```ts
// server.ts (Angular SSR) or any Node backend
import Pusher from 'pusher';
import OpenAI from 'openai';
import { randomUUID } from 'node:crypto';
import { streamToChannel } from '@hibira-io/angular/server';

const openai = new OpenAI();

app.post('/api/ask', express.json(), async (req, res) => {
  const { conversationId, question } = req.body;
  const stream = await openai.chat.completions.create({
    model: 'gpt-5',
    stream: true,
    messages: [{ role: 'user', content: question }],
  });
  // Don't await: answer the request now and keep streaming to the channel.
  const id = randomUUID();
  streamToChannel(pusher, `private-conversation-${conversationId}`, stream, { id, meta: { role: 'assistant' } })
    .catch((err) => console.error('stream failed', err));
  res.json({ id });
});
```

Then in the browser:

```ts
@Component({
  selector: 'app-answer',
  template: `<p [attr.aria-busy]="!answer.done()">{{ answer.text() }}
    @if (answer.error(); as error) { <em>(stopped: {{ error }})</em> }</p>`,
})
export class Answer {
  conversationId = input.required<string>();
  answer = injectStream(() => `private-conversation-${this.conversationId()}`);
}
```

Every subscriber sees the same answer as it is written: other tabs, other
devices, teammates in a shared conversation. `injectStream()` follows the
stream that started last; pass `{ id }` (a value, signal or function) to
follow one, or read `streams()` for all of them (by id, each
`{ id, text, done, error, meta, incomplete }`).

`streamToChannel(pusher, channel, source, options)` options:

| Option | Default | |
| --- | --- | --- |
| `id` | random UUID | stream id, also returned |
| `event` | `'ai-stream'` | event name |
| `interval` | `100` | ms to gather tokens into one event |
| `maxBytes` | `3500` | largest event; Free plans allow 4 KB per message |
| `meta` | | JSON sent with the first event (model, message id, author) |
| `pick` | | `(chunk) => text` for a source it does not know |
| `socketId` | | leave out the sender's own connection |
| `signal` | | an `AbortSignal` to stop; subscribers get `error: 'aborted'` |

It resolves to `{ id, text, events }` once the last event is sent, and
rejects when the source or the HTTP API fails, after telling subscribers.

How it works: tokens are batched into one event per `interval` (100 ms by
default), so a model writing 50 tokens a second sends about 10 events a
second rather than 50. Each event carries a sequence number and
`injectStream()` applies them in order. The last event carries the whole
text when it fits in one message, so someone who subscribed halfway through,
or whose connection dropped for a moment, still ends with the full answer;
otherwise their stream is marked `incomplete`.

### Reloads and dropped connections: `rewind`

Turn on channel history for the app (app settings in the Hibira portal,
Hobby plans and up) and pass `rewind`, and nothing is lost: a page reloaded
halfway through an answer, or a phone that lost signal for a few seconds,
picks the answer up from its first token.

```ts
answer = injectStream(() => `private-conversation-${this.conversationId()}`, { rewind: true });
```

Each time the channel is subscribed, the first time and again after a
reconnect, `injectStream()` asks the server for the events it missed
(`pusher:rewind`): the last 300 seconds the first time, the time since the
last event after a reconnect. Live events are held for that moment and
everything is applied in order, without duplicates.

| `rewind` option | Default | |
| --- | --- | --- |
| `seconds` | `300` | history asked for on the first subscription (the app's history window caps it) |
| `limit` | all kept | at most this many events |
| `timeout` | `5000` | ms to wait for the server before going on without history |

`history()` is the last answer: `{ count, window, complete }`, or
`{ error }` when history is off or not in the app's plan (the stream then
works as without `rewind`). Replayed events reach every listener on the
channel. `followStream(channel, { apply, rewind })` does the same for any
pusher-js channel.

Use a private or presence channel for anything personal, so only the people
your auth endpoint allows can subscribe.

## Laravel AI SDK agents: `injectAgentStream`

For agents built with the [Laravel AI SDK](https://github.com/laravel/ai)
and broadcast with [`hibira-io/laravel`](https://github.com/hibira-io/laravel):

```php
// Laravel: queue the agent, stream its events to the user's private channel
use Hibira\Laravel\Ai\AgentChannel;

(new SalesCoach)->broadcastOnQueue($request->input('prompt'), AgentChannel::user($request->user()));
```

```ts
// in a component: every field is a signal
agent = injectAgentStream(() => `private-hibira-ai.user.${this.userId()}`, { rewind: true });
// agent.text(), agent.reasoning(), agent.status(), agent.toolCalls(), agent.approvals(), agent.error()
```

It listens to every Laravel AI stream event (`text_delta`,
`reasoning_delta`, `tool_call`, `tool_result`, `tool_approval_request`,
`stream_end`, errors) and puts each run (one `invocation_id`) back together.
`status` is `idle`, `streaming`, `awaiting_approval`, `done` or `error`;
`run().parts` lists text, reasoning and tool calls in the order they
started, for rendering a chat transcript. Events bigger than the plan's
per-event limit (4 KB on Free) arrive split into `hibira:chunk` events,
which are joined; replays from `rewind` are dropped by event id.

| Option | Default | |
| --- | --- | --- |
| `invocationId` | | follow only this run (a value, signal or function); otherwise the one that started last |
| `rewind` | off | as for `injectStream()` |
| `maxRuns` | `20` | runs kept, oldest dropped first |
| `events` | | extra event names, such as a provider's own error types |

`createAgentStore(onChange)` is the same without Angular, for any pusher-js
channel.

## Server rendering

`provideHibira()` opens nothing on the server: during SSR and prerendering
`injectPusher()` is `null`, `injectConnectionState()` is `'initialized'`,
and the other signals keep their empty values. In the browser the client
opens as the app hydrates. CI builds a real `ng new --ssr` app on Angular 17
and the latest Angular, prerenders it, and runs it in Chromium against a
Pusher-compatible server.

## Licence

MIT

## 中文摘要

`@hibira-io/angular` 是給 Angular 17 以上使用的 Hibira（或任何 Pusher 相容伺服器）
即時連線套件，所有狀態都是 signal。用 `provideHibira({ appKey })` 設定一次連線，
在元件裡用 `injectChannel`、`injectEvent`、`injectPresence`、`injectTrigger`、
`injectConnectionState` 取得頻道、事件、在線成員、client event 與連線狀態；
頻道名稱可以是 signal 或函式（包含元件 input），訂閱會自動跟著切換，元件銷毀時自動釋放。
LLM 串流用後端的 `streamToChannel()` 送出、前端的 `injectStream()` 組回全文，
開啟頻道歷史後加上 `rewind: true`，重新整理或斷線也不會漏字。
Laravel AI SDK 的 agent 串流用 `injectAgentStream()`。SSR／預先渲染時不會建立連線。
