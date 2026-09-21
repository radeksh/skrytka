import { fromBase64Url } from './base64url.js';
import { DecryptError, decryptBytes, decryptText, hasWebCrypto, isValidKeyString } from './crypto.js';
import { formatBytes, unpackEnvelope } from './envelope.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const $ = (id) => document.getElementById(id);
const els = {
  welcome: $('welcome'), content: $('content'), error: $('error'), errorText: $('errorText'),
  keyHint: $('keyHint'), fileHint: $('fileHint'), key: $('key'), toggleKey: $('toggleKey'), keyError: $('keyError'),
  textBox: $('textBox'), fileBox: $('fileBox'), fileStatus: $('fileStatus'), fileLink: $('fileLink'), fileError: $('fileError'),
  reveal: $('reveal'), burnWarn: $('burnWarn'), plaintext: $('plaintext'), copy: $('copy'), copied: $('copied'),
  burnNotice: $('burnNotice'), expiry: $('expiry')
};

const noteId = location.pathname.replace(/^\/+|\/+$/g, '');

function showFatal(message) {
  els.welcome.classList.add('hidden');
  els.content.classList.add('hidden');
  els.errorText.textContent = message;
  els.error.classList.remove('hidden');
}

function currentKey() {
  return els.key.value.trim();
}

function validateKey() {
  const key = currentKey();
  const valid = isValidKeyString(key);
  els.reveal.disabled = !valid;
  els.keyError.classList.toggle('hidden', valid || key.length === 0);
  return valid;
}

function toggleKeyVisibility() {
  const hidden = els.key.type === 'password';
  els.key.type = hidden ? 'text' : 'password';
  els.toggleKey.textContent = hidden ? 'Ukryj' : 'Pokaż';
}

async function copyPlaintext() {
  try {
    await navigator.clipboard.writeText(els.plaintext.textContent);
    els.copied.classList.remove('hidden');
    setTimeout(() => els.copied.classList.add('hidden'), 2000);
  } catch {
    const range = document.createRange();
    range.selectNodeContents(els.plaintext);
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }
}

async function loadInfo() {
  let response;
  try {
    response = await fetch(`/api/notes/${noteId}/info`, { cache: 'no-store' });
  } catch {
    return;
  }
  if (response.status === 404) {
    return showFatal('Wiadomość nie istnieje, wygasła lub została już odczytana. Jeśli to nie Ty ją odczytałeś, skontaktuj się z nadawcą.');
  }
  if (!response.ok) return;
  const info = await response.json();
  els.burnWarn.classList.toggle('hidden', !info.burnAfterRead);
  if (info.hasFile) {
    els.fileHint.textContent = `Wiadomość zawiera zaszyfrowany załącznik (${formatBytes(info.fileSize)}).`;
    els.fileHint.classList.remove('hidden');
  }
}

async function loadFile(fileRef, meta, rawKey) {
  els.fileBox.classList.remove('hidden');
  let response;
  try {
    response = await fetch(`/api/notes/${noteId}/file/${fileRef.token}`, { cache: 'no-store' });
  } catch {
    response = null;
  }
  if (!response || !response.ok) {
    els.fileStatus.classList.add('hidden');
    els.fileError.textContent = 'Nie udało się pobrać załącznika. Odśwież stronę, jeśli wiadomość jest wielokrotna, albo poproś nadawcę o nową.';
    els.fileError.classList.remove('hidden');
    return;
  }
  try {
    const plain = await decryptBytes(new Uint8Array(await response.arrayBuffer()), rawKey);
    const blob = new Blob([plain], { type: meta?.type || 'application/octet-stream' });
    const name = meta?.name || 'zalacznik.bin';
    els.fileLink.href = URL.createObjectURL(blob);
    els.fileLink.download = name;
    els.fileLink.textContent = `Pobierz plik: ${name} (${formatBytes(blob.size)})`;
    els.fileLink.classList.remove('hidden');
    els.fileStatus.textContent = 'Załącznik odszyfrowany w przeglądarce. Zapisz go teraz.';
  } catch {
    els.fileStatus.classList.add('hidden');
    els.fileError.textContent = 'Nie udało się odszyfrować załącznika.';
    els.fileError.classList.remove('hidden');
  }
}

async function reveal() {
  if (!validateKey()) return;
  els.reveal.disabled = true;
  els.reveal.textContent = 'Odczytywanie...';

  let response;
  try {
    response = await fetch(`/api/notes/${noteId}`, { cache: 'no-store' });
  } catch {
    els.reveal.disabled = false;
    els.reveal.textContent = 'Odczytaj wiadomość';
    return showFatal('Nie udało się połączyć z serwerem. Odśwież stronę i spróbuj ponownie.');
  }

  if (response.status === 404) {
    return showFatal('Wiadomość nie istnieje, wygasła lub została już odczytana. Jeśli to nie Ty ją odczytałeś, skontaktuj się z nadawcą.');
  }
  if (response.status === 429) {
    els.reveal.disabled = false;
    els.reveal.textContent = 'Odczytaj wiadomość';
    return showFatal('Zbyt wiele prób. Odczekaj chwilę i spróbuj ponownie.');
  }
  if (!response.ok) {
    return showFatal(`Serwer odpowiedział błędem (${response.status}).`);
  }

  const data = await response.json();
  const rawKey = fromBase64Url(currentKey());
  let text;
  try {
    text = await decryptText(data, rawKey);
  } catch (err) {
    if (err instanceof DecryptError) {
      const extra = data.burnAfterRead
        ? ' Wiadomość była jednorazowa i została już usunięta z serwera. Poproś nadawcę o nową.'
        : ' Sprawdź, czy skopiowano cały klucz i spróbuj ponownie.';
      return showFatal('Nie udało się odszyfrować wiadomości: klucz jest nieprawidłowy.' + extra);
    }
    return showFatal('Wystąpił nieoczekiwany błąd podczas odszyfrowywania.');
  }

  const envelope = unpackEnvelope(text);
  els.plaintext.textContent = envelope.text;
  els.textBox.classList.toggle('hidden', envelope.text.length === 0);
  els.burnNotice.classList.toggle('hidden', !data.burnAfterRead);
  if (!data.burnAfterRead) {
    const date = document.createElement('strong');
    date.className = 'expiry-date';
    date.textContent = new Date(data.expiresAt).toLocaleString('pl-PL', { dateStyle: 'long', timeStyle: 'short' });
    els.expiry.replaceChildren('Wiadomość pozostanie dostępna do ', date, '.');
    els.expiry.classList.remove('hidden');
  }
  els.welcome.classList.add('hidden');
  els.content.classList.remove('hidden');

  if (data.burnAfterRead) {
    history.replaceState(null, '', location.pathname);
  }
  if (data.file) {
    await loadFile(data.file, envelope.file, rawKey);
  }
}

function init() {
  if (!UUID_RE.test(noteId)) return showFatal('Ten link jest nieprawidłowy.');
  if (!hasWebCrypto()) return showFatal('Ta przeglądarka nie udostępnia Web Crypto. Strona wymaga połączenia HTTPS.');

  const fragment = location.hash.replace(/^#/, '').trim();
  if (isValidKeyString(fragment)) {
    els.key.value = fragment;
  } else {
    els.keyHint.textContent = 'Do odczytania potrzebny jest klucz. Wklej go poniżej.';
    els.keyHint.classList.remove('hidden');
    if (fragment) els.keyError.classList.remove('hidden');
  }
  validateKey();
  loadInfo();

  els.key.addEventListener('input', validateKey);
  els.toggleKey.addEventListener('click', toggleKeyVisibility);
  els.reveal.addEventListener('click', reveal);
  els.copy.addEventListener('click', copyPlaintext);
}

init();
