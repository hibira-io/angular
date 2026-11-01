# Changelog

## 0.1.0

- First release. `provideHibira()` and the signal-based inject functions
  `injectPusher`, `injectChannel`, `injectEvent`, `injectPresence`,
  `injectTrigger`, `injectConnectionState`, `injectStream` (with `rewind`)
  and `injectAgentStream`, plus `streamToChannel` from
  `@hibira-io/angular/server`. Shares the stream, agent and server code of
  @hibira-io/react and @hibira-io/vue 0.2.1.
- Angular 17 to 22, standalone or NgModule, with or without zone.js; nothing
  connects during server rendering or prerendering.
