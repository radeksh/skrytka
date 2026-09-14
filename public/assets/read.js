import { fromBase64Url } from './base64url.js';
import { DecryptError, decryptText, hasWebCrypto, isValidKeyString } from './crypto.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const $ = (id) => document.getElementById(id);
const els = {
  welcome: $('welcome'), content: $('content'), error: $('error'), errorText: $('errorText'),
  keyHint: $('keyHint'), key: $('key'), toggleKey: $('toggleKey'), keyError: $('keyError'),
  reveal: $('reveal'), plaintext: $('plaintext'), copy: $('copy'), copied: $('copied'),
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
  let text;
  try {
    text = await decryptText(data, fromBase64Url(currentKey()));
  } catch (err) {
    if (err instanceof DecryptError) {
      const extra = data.burnAfterRead
        ? ' Wiadomość była jednorazowa i została już usunięta z serwera. Poproś nadawcę o nową.'
        : ' Sprawdź, czy skopiowano cały klucz i spróbuj ponownie.';
      return showFatal('Nie udało się odszyfrować wiadomości: klucz jest nieprawidłowy.' + extra);
    }
    return showFatal('Wystąpił nieoczekiwany błąd podczas odszyfrowywania.');
  }

  els.plaintext.textContent = text;
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
}

function init() {
  if (!UUID_RE.test(noteId)) return showFatal('Ten link jest nieprawidłowy.');
  if (!hasWebCrypto()) return showFatal('Ta przeglądarka nie udostępnia Web Crypto. Strona wymaga połączenia HTTPS.');

  const fragment = location.hash.replace(/^#/, '').trim();
  if (isValidKeyString(fragment)) {
    els.keyHint.textContent = 'I wygląda na to, że masz klucz!';
    els.key.value = fragment;
  } else {
    els.keyHint.textContent = 'Do odczytania potrzebny jest klucz. Wklej go poniżej.';
    if (fragment) els.keyError.classList.remove('hidden');
  }
  validateKey();

  els.key.addEventListener('input', validateKey);
  els.toggleKey.addEventListener('click', toggleKeyVisibility);
  els.reveal.addEventListener('click', reveal);
  els.copy.addEventListener('click', copyPlaintext);
}

init();
