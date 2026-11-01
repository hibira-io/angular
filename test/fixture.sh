#!/usr/bin/env bash
# Builds a real Angular CLI app (with SSR and prerendering) on the packed
# package: proves the plain-ESM package goes through the Angular compiler,
# esbuild and strict type checking, and that prerendering never connects.
#
#   test/fixture.sh <angular major> <dir>
set -euo pipefail
major="$1"
dir="$2"
root="$(cd "$(dirname "$0")/.." && pwd)"

tarball="$(cd "$root" && npm pack --silent --pack-destination "$dir")"
cd "$dir"
npx -y "@angular/cli@$major" new fixture --ssr --defaults --skip-git --skip-tests --style=css --interactive=false >/dev/null
cd fixture
npm install --silent "../$tarball" pusher-js@8

# Root component: app.ts / class App (Angular 20+) or app.component.ts / AppComponent.
if [ -f src/app/app.component.ts ]; then file=src/app/app.component.ts; class=AppComponent; else file=src/app/app.ts; class=App; fi
sed "s/__CLASS__/$class/" "$root/test/fixture/component.ts" >"$file"

node - <<'JS'
const fs = require('fs');
const p = 'src/app/app.config.ts';
let s = fs.readFileSync(p, 'utf8');
s = "import { provideHibira } from '@hibira-io/angular';\n" + s;
s = s.replace(/providers:\s*\[/, `providers: [
    provideHibira({
      appKey: typeof location === 'undefined' ? 'server' : new URLSearchParams(location.search).get('key') ?? 'key',
      options: typeof location === 'undefined' ? {} : {
        wsHost: new URLSearchParams(location.search).get('host') ?? '127.0.0.1',
        wsPort: Number(new URLSearchParams(location.search).get('port') ?? 8080),
        forceTLS: false,
        enabledTransports: ['ws'],
      },
    }),`);
fs.writeFileSync(p, s);
JS

npx ng build >/dev/null
page="$(find dist -path '*browser*' -name index.html | head -1)"
grep -q 'state: initialized' "$page" || { echo "prerendered page lacks the server state:"; cat "$page"; exit 1; }
grep -q 'client: no' "$page" || { echo "prerendering opened a client"; exit 1; }
echo "ok: Angular $(node -p "require('@angular/core/package.json').version") built and prerendered $page"
