// The fixture app's root component, written over the one `ng new` made (see
// test/fixture.sh). The connection settings come from the page's query
// string so one build can point at any server: ?key=...&host=...&port=...
import { Component, signal } from '@angular/core';
import {
  injectChannel,
  injectConnectionState,
  injectEvent,
  injectPusher,
  injectStream,
} from '@hibira-io/angular';

@Component({
  selector: 'app-root',
  standalone: true,
  template: `
    <p id="state">state: {{ state() }}</p>
    <p id="client">client: {{ client ? 'yes' : 'no' }}</p>
    <p id="channel">channel: {{ channel()?.name ?? 'none' }}</p>
    <ul id="events">
      @for (e of events(); track $index) {
        <li>{{ e.text }}</li>
      }
    </ul>
    <p id="stream">stream: {{ stream.text() }}{{ stream.done() ? ' (done)' : '' }}</p>
  `,
})
export class __CLASS__ {
  readonly client = injectPusher();
  readonly state = injectConnectionState();
  readonly room = signal('fixture');
  readonly channel = injectChannel(this.room);
  readonly events = signal<{ text: string }[]>([]);
  readonly stream = injectStream(this.channel);

  constructor() {
    injectEvent<{ text: string }>(this.channel, 'note', (e) => this.events.update((l) => [...l, e]));
  }
}
