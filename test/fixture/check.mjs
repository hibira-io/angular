// Opens the fixture app built by test/fixture.sh in Chromium against a real
// Pusher-compatible server, and checks that the prerendered page hydrates,
// connects, and shows an event and a streamed answer sent from the server.
//
//   node test/fixture/check.mjs <dir with index.html>
// with HIBIRA_E2E_APP_ID / _KEY / _SECRET / _HOST / _PORT set (soketi's
// defaults: app-id, app-key, app-secret, 127.0.0.1, 6001).
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { createRequire } from 'node:module';
import PusherServer from 'pusher';
import { streamToChannel } from '../../server.js';

// require() so a globally installed Playwright (NODE_PATH) works too.
const { chromium } = createRequire(import.meta.url)('playwright');

const dir = process.argv[2];
const env = process.env;
const host = env.HIBIRA_E2E_HOST ?? '127.0.0.1';
const port = env.HIBIRA_E2E_PORT ?? '6001';
const key = env.HIBIRA_E2E_KEY ?? 'app-key';
const server = new PusherServer({
  appId: env.HIBIRA_E2E_APP_ID ?? 'app-id',
  key,
  secret: env.HIBIRA_E2E_SECRET ?? 'app-secret',
  host,
  port,
  useTLS: false,
});

const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.ico': 'image/x-icon' };
const web = createServer(async (req, res) => {
  const path = normalize(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '') || 'index.html';
  try {
    const body = await readFile(join(dir, path));
    res.writeHead(200, { 'content-type': types[extname(path)] ?? 'application/octet-stream' }).end(body);
  } catch {
    res.writeHead(200, { 'content-type': 'text/html' }).end(await readFile(join(dir, 'index.html')));
  }
}).listen(0);
const url = `http://127.0.0.1:${web.address().port}/?key=${key}&host=${host}&port=${port}`;

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto(url);
  await page.locator('#state', { hasText: 'state: connected' }).waitFor({ timeout: 15000 });
  await page.locator('#channel', { hasText: 'channel: fixture' }).waitFor();
  await page.waitForTimeout(500); // the subscription reaches the server

  await server.trigger('fixture', 'note', { text: 'hello from the server' });
  await page.locator('#events li', { hasText: 'hello from the server' }).waitFor({ timeout: 5000 });

  async function* llm() {
    for (const word of ['Signals ', 'all ', 'the ', 'way ', 'down.']) {
      await new Promise((r) => setTimeout(r, 20));
      yield word;
    }
  }
  const res = await streamToChannel(server, 'fixture', llm(), { interval: 30 });
  await page.locator('#stream', { hasText: `stream: ${res.text} (done)` }).waitFor({ timeout: 5000 });
  if (errors.length) throw new Error(`errors in the page:\n${errors.join('\n')}`);
  if (env.SCREENSHOT) await page.screenshot({ path: env.SCREENSHOT });
  console.log('ok: the fixture app connected and showed an event and a stream');
} finally {
  await browser.close();
  web.close();
}
