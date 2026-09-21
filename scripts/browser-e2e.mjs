// End-to-end click-through in headless Chrome over the DevTools pipe.
// Usage: BASE=http://localhost:3000 TEST_FILE=./some.bin node scripts/browser-e2e.mjs
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const BASE = (process.env.BASE || 'http://localhost:3000').replace(/\/$/, '');
const CHROME = process.env.CHROME || 'google-chrome';
const profile = process.env.PROFILE || mkdtempSync(join(tmpdir(), 'skrytka-chrome-'));
let filePath = process.env.TEST_FILE;
if (!filePath) {
  filePath = join(profile, 'testfile.bin');
  const bytes = new Uint8Array(300_000);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + 7) & 0xff;
  writeFileSync(filePath, bytes);
}
const fileName = filePath.split('/').pop();

const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--remote-debugging-pipe', `--user-data-dir=${profile}`, 'about:blank'], {
  stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe']
});

const pending = new Map();
const events = [];
let seq = 0;
let buf = '';
chrome.stdio[4].on('data', (chunk) => {
  buf += chunk.toString();
  let idx;
  while ((idx = buf.indexOf('\0')) !== -1) {
    const msg = JSON.parse(buf.slice(0, idx));
    buf = buf.slice(idx + 1);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    } else if (msg.method) {
      events.push(msg);
    }
  }
});

function send(method, params = {}, sessionId) {
  const id = ++seq;
  const payload = { id, method, params };
  if (sessionId) payload.sessionId = sessionId;
  chrome.stdio[3].write(JSON.stringify(payload) + '\0');
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
await send('Page.enable', {}, sessionId);
await send('Runtime.enable', {}, sessionId);
await send('Network.enable', {}, sessionId);
const downloadDir = join(profile, 'downloads');
await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDir, eventsEnabled: true });
const waitForDownload = async (name, expectedSize, tries = 200) => {
  const target = join(downloadDir, name);
  for (let i = 0; i < tries; i++) {
    if (existsSync(target) && !readdirSync(downloadDir).some((f) => f.endsWith('.crdownload')) && statSync(target).size === expectedSize) return readFileSync(target);
    await sleep(50);
  }
  throw new Error('timeout waiting for download ' + name);
};

const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + JSON.stringify(r.exceptionDetails.exception));
  return r.result.value;
};
const navigate = async (url) => {
  await send('Page.navigate', { url: 'about:blank' }, sessionId);
  await sleep(100);
  events.length = 0;
  await send('Page.navigate', { url }, sessionId);
  for (let i = 0; i < 100; i++) {
    if (events.some((e) => e.method === 'Page.loadEventFired')) break;
    await sleep(50);
  }
  await sleep(200);
};
const waitFor = async (expression, label, tries = 200) => {
  for (let i = 0; i < tries; i++) {
    if (await evaluate(expression)) return;
    await sleep(50);
  }
  throw new Error('timeout waiting for ' + label);
};
const setFileInput = async (selector, path) => {
  const { root } = await send('DOM.getDocument', { depth: 1 }, sessionId);
  const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector }, sessionId);
  await send('DOM.setFileInputFiles', { nodeId, files: [path] }, sessionId);
};
const apiRequests = () => events.filter((e) => e.method === 'Network.requestWillBeSent').map((e) => e.params.request.url).filter((u) => u.includes('/api/'));
const consoleErrors = () => events.filter((e) => e.method === 'Runtime.exceptionThrown' || (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error')).length;
const sha256 = async (bytes) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))).map((x) => x.toString(16).padStart(2, '0')).join('');
const fillNote = (text) => evaluate(`(() => { const t = document.getElementById('note'); t.value = ${JSON.stringify(text)}; t.dispatchEvent(new Event('input')); return true; })()`);
const clickCreate = (burn) => evaluate(`document.getElementById('burn').checked = ${burn}; document.getElementById('create').click(); true`);
const waitResult = (label) => waitFor(`!document.getElementById('result').classList.contains('hidden')`, label);
const clickReveal = () => evaluate(`document.getElementById('reveal').click(); true`);
const contentOrError = `!document.getElementById('content').classList.contains('hidden') || !document.getElementById('error').classList.contains('hidden')`;
const fileLinkOrError = `!document.getElementById('fileLink').classList.contains('hidden') || !document.getElementById('fileError').classList.contains('hidden')`;

const results = [];
const check = (name, ok, extra = '') => results.push({ name, ok, extra });

try {
  // 1. sender
  await navigate(`${BASE}/create`);
  const secret = 'login: admin\nhasło: Zażółć gęślą jaźń <b>&</b>';
  await fillNote(secret);
  check('create: button enabled after typing', await evaluate(`!document.getElementById('create').disabled`));
  check('create: how-it-works collapsed by default', await evaluate(`!document.querySelector('details.howto').open`));
  await clickCreate(true);
  await waitResult('result');
  const link = await evaluate(`document.getElementById('link').value`);
  const keyShown = await evaluate(`document.getElementById('key').value`);
  check('create: link is /<uuid>#<key43>', link.startsWith(BASE + '/') && /\/[0-9a-f-]{36}#[A-Za-z0-9_-]{43}$/.test(link), link);
  check('create: key field equals fragment', link.endsWith('#' + keyShown));
  check('create: link without key equals link up to #', (await evaluate(`document.getElementById('linkNoKey').value`)) === link.split('#')[0]);
  check('create: expiry under h2 with highlighted date', await evaluate(`document.getElementById('expiry').previousElementSibling.tagName === 'H2' && document.getElementById('expiry').textContent.startsWith('Wiadomość jednorazowa. Wygaśnie ') && document.querySelector('#expiry strong.expiry-date') !== null`));
  check('create: textarea cleared', (await evaluate(`document.getElementById('note').value`)) === '');
  const createReqs = apiRequests();
  check('create: single POST /api/create', createReqs.length === 1 && createReqs[0].endsWith('/api/create'), createReqs.join(','));
  check('create: no console or CSP errors', consoleErrors() === 0);

  // 2. recipient with key
  await navigate(link);
  await sleep(400);
  check('read: lead says "w skrytce", key hint hidden', await evaluate(`document.querySelector('#welcome .lead').textContent.includes('w skrytce') && document.getElementById('keyHint').classList.contains('hidden')`));
  check('read: one-time warning visible', await evaluate(`!document.getElementById('burnWarn').classList.contains('hidden')`));
  check('read: password field prefilled', await evaluate(`document.getElementById('key').type === 'password' && document.getElementById('key').value === ${JSON.stringify(keyShown)}`));
  await evaluate(`document.getElementById('toggleKey').click(); true`);
  check('read: toggle reveals key', await evaluate(`document.getElementById('key').type === 'text' && document.getElementById('toggleKey').textContent === 'Ukryj'`));
  check('read: only /info requested before click', apiRequests().length === 1 && apiRequests()[0].endsWith('/info'), apiRequests().join(','));
  await clickReveal();
  await waitFor(contentOrError, 'content');
  const plaintext = await evaluate(`document.getElementById('plaintext').textContent`);
  check('read: decrypted text identical', plaintext === secret, JSON.stringify(plaintext));
  check('read: text inserted as text, not HTML', await evaluate(`document.getElementById('plaintext').children.length === 0`));
  check('read: burn notice visible', await evaluate(`!document.getElementById('burnNotice').classList.contains('hidden')`));
  check('read: fragment removed from address bar', (await evaluate(`location.hash`)) === '');
  check('read: no console or CSP errors', consoleErrors() === 0);

  // 3. reread
  await navigate(link);
  await waitFor(`!document.getElementById('error').classList.contains('hidden')`, 'error');
  const errText = await evaluate(`document.getElementById('errorText').textContent`);
  check('reread: missing note reported without clicking', errText.includes('wygasła lub została już odczytana'), errText);

  // 4. link without key
  await navigate(link.split('#')[0]);
  check('nokey: paste hint visible', await evaluate(`!document.getElementById('keyHint').classList.contains('hidden') && document.getElementById('keyHint').textContent.startsWith('Do odczytania potrzebny jest klucz')`));
  check('nokey: reveal disabled', await evaluate(`document.getElementById('reveal').disabled`));
  await evaluate(`(() => { const k = document.getElementById('key'); k.value = 'zly-klucz'; k.dispatchEvent(new Event('input')); return true; })()`);
  check('nokey: malformed key shows error and blocks', await evaluate(`document.getElementById('reveal').disabled && !document.getElementById('keyError').classList.contains('hidden')`));
  await evaluate(`(() => { const k = document.getElementById('key'); k.value = ${JSON.stringify(keyShown)}; k.dispatchEvent(new Event('input')); return true; })()`);
  check('nokey: valid key enables reveal', await evaluate(`!document.getElementById('reveal').disabled`));

  // 5. multi-read note, wrong then right key
  await navigate(`${BASE}/create`);
  await fillNote('multi');
  await clickCreate(false);
  await waitResult('result2');
  const link2 = await evaluate(`document.getElementById('link').value`);
  const badLink = link2.slice(0, -1) + (link2.endsWith('A') ? 'B' : 'A');
  await navigate(badLink);
  await sleep(400);
  check('multi: no one-time warning', await evaluate(`document.getElementById('burnWarn').classList.contains('hidden')`));
  await clickReveal();
  await waitFor(`!document.getElementById('error').classList.contains('hidden')`, 'error2');
  const badText = await evaluate(`document.getElementById('errorText').textContent`);
  check('multi: wrong key gives decrypt error', badText.includes('klucz jest nieprawidłowy') && badText.includes('Sprawdź'), badText);
  await navigate(link2);
  await sleep(300);
  await clickReveal();
  await waitFor(`!document.getElementById('content').classList.contains('hidden')`, 'content2');
  check('multi: right key still reads', (await evaluate(`document.getElementById('plaintext').textContent`)) === 'multi');
  check('multi: expiry shown, no burn notice', await evaluate(`document.getElementById('burnNotice').classList.contains('hidden') && !document.getElementById('expiry').classList.contains('hidden') && document.querySelector('#expiry strong.expiry-date') !== null`));
  check('multi: fragment kept in address bar', (await evaluate(`location.hash.length`)) === 44);

  // 6. text plus file, one-time
  const fileBytes = readFileSync(filePath);
  await navigate(`${BASE}/create`);
  await fillNote('tekst z plikiem');
  await setFileInput('#file', filePath);
  await sleep(200);
  check('file: name shown after selection', (await evaluate(`document.getElementById('fileInfo').textContent`)).includes(fileName));
  await clickCreate(true);
  await waitResult('result3');
  const link3 = await evaluate(`document.getElementById('link').value`);
  const createReqs3 = apiRequests();
  check('file: single POST /api/create', createReqs3.length === 1 && createReqs3[0].endsWith('/api/create'), createReqs3.join(','));
  await navigate(link3);
  await sleep(500);
  check('file: attachment hint before reading', (await evaluate(`document.getElementById('fileHint').textContent`)).includes('załącznik'));
  await clickReveal();
  await waitFor(fileLinkOrError, 'fileLink');
  check('file: text decrypted', (await evaluate(`document.getElementById('plaintext').textContent`)) === 'tekst z plikiem');
  const linkText = await evaluate(`document.getElementById('fileLink').textContent`);
  check('file: download link carries file name', linkText.includes(fileName), linkText);
  check('file: download attribute equals name', (await evaluate(`document.getElementById('fileLink').download`)) === fileName);
  await evaluate(`document.getElementById('fileLink').click(); true`);
  const downloaded = await waitForDownload(fileName, fileBytes.byteLength);
  check('file: downloaded file identical (SHA-256)', (await sha256(downloaded)) === (await sha256(fileBytes)));
  check('file: no console or CSP errors', consoleErrors() === 0);
  const fileReq = apiRequests().find((u) => u.includes('/file/'));
  const again = await fetch(fileReq);
  check('file: download token is single use', again.status === 404, String(again.status));

  // 7. file only, multi-read
  await navigate(`${BASE}/create`);
  await setFileInput('#file', filePath);
  await sleep(200);
  check('fileonly: create enabled without text', await evaluate(`!document.getElementById('create').disabled`));
  await clickCreate(false);
  await waitResult('result4');
  const link4 = await evaluate(`document.getElementById('link').value`);
  for (const round of [1, 2]) {
    await navigate(link4);
    await sleep(300);
    await clickReveal();
    await waitFor(fileLinkOrError, `fileLink round ${round}`);
    check(`fileonly: round ${round} text hidden, download visible`, await evaluate(`document.getElementById('textBox').classList.contains('hidden') && !document.getElementById('fileLink').classList.contains('hidden')`));
  }
} catch (err) {
  let state = '';
  try {
    state = await evaluate(`JSON.stringify({ url: location.href, error: document.getElementById('error')?.className, errorText: document.getElementById('errorText')?.textContent, fileError: document.getElementById('fileError')?.textContent, content: document.getElementById('content')?.className, revealDisabled: document.getElementById('reveal')?.disabled })`);
  } catch {}
  const consoleMsgs = events.filter((e) => e.method === 'Runtime.consoleAPICalled' || e.method === 'Runtime.exceptionThrown').map((e) => JSON.stringify(e.params).slice(0, 300));
  check('EXCEPTION', false, `${err.message} | state=${state} | api=${apiRequests().join(',')} | console=${consoleMsgs.join(' ;; ')}`);
} finally {
  const exited = new Promise((resolve) => chrome.once('exit', resolve));
  chrome.kill();
  await Promise.race([exited, sleep(5000)]);
  if (!process.env.PROFILE) {
    try {
      rmSync(profile, { recursive: true, force: true });
    } catch {}
  }
}

for (const r of results) console.log(`${r.ok ? 'OK  ' : 'FAIL'} ${r.name}${r.extra && !r.ok ? '  :: ' + r.extra : ''}`);
console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
