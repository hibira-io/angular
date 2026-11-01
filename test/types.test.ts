// Compiled by `npm run typecheck`, never run.
import { Component, Injectable, inject, Injector, input, signal } from '@angular/core';
import { bootstrapApplication } from '@angular/platform-browser';
import {
  HIBIRA,
  injectAgentStream,
  injectChannel,
  injectConnectionState,
  injectEvent,
  injectPresence,
  injectPusher,
  injectStream,
  injectTrigger,
  provideHibira,
  type ConnectionState,
} from '@hibira-io/angular';
import { streamToChannel } from '@hibira-io/angular/server';

@Component({ selector: 'app-room', standalone: true, template: '{{ count() }}' })
export class Room {
  roomId = input.required<string>();
  orders = signal<{ text: string }[]>([]);
  channel = injectChannel(() => `private-order-${this.roomId()}`);
  sub = injectEvent<{ text: string }>(this.channel, 'message', (m) => this.orders.update((l) => [m, ...l]));
  presence = injectPresence<{ name: string }>(() => `presence-room-${this.roomId()}`);
  names = () => this.presence.members().map((m) => m.info?.name satisfies string | undefined);
  count = this.presence.count;
  trigger = injectTrigger('private-chat');
  ai = injectStream<{ model: string }>('private-ai', { id: signal('s1'), rewind: true });
  model = (): string | undefined => this.ai.stream()?.meta?.model;
  agent = injectAgentStream('private-hibira-ai.user.1', { rewind: { seconds: 60 }, invocationId: signal('inv') });
  status = (): 'idle' | 'streaming' | 'awaiting_approval' | 'done' | 'error' => this.agent.status();
  firstTool = (): string | undefined => this.agent.toolCalls()[0]?.name ?? undefined;
  state: () => ConnectionState = injectConnectionState();

  typing() {
    const sent: boolean = this.trigger('client-typing', {});
    return sent;
  }
}

@Injectable({ providedIn: 'root' })
export class Feed {
  private injector = inject(Injector);
  pusher = injectPusher();
  hibira = inject(HIBIRA);
  later() {
    return injectStream('private-later', { injector: this.injector }).text();
  }
}

bootstrapApplication(Room, {
  providers: [provideHibira({ appKey: 'key', options: { channelAuthorization: { endpoint: '/auth', transport: 'ajax' } } })],
});

export async function server(pusher: { trigger(c: string, e: string, d: any, x?: any): Promise<any> }) {
  const r = await streamToChannel(pusher, 'private-ai', ['a', 'b'], { meta: { model: 'm' } });
  return r.id + r.text;
}
