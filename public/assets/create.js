import { toBase64Url } from './base64url.js';
import { encryptText, generateRawKey, hasWebCrypto } from './crypto.js';

const $ = (id) => document.getElementById(id);
const els = {
  form: $('form'), result: $('result'), note: $('note'), bytes: $('bytes'), maxBytes: $('maxBytes'),
  ttl: $('ttl'), burn: $('burn'), create: $('create'), formError: $('formError'),
  link: $('link'), linkNoKey: $('linkNoKey'), key: $('key'),
  copyLink: $('copyLink'), copyLinkNoKey: $('copyLinkNoKey'), copyKey: $('copyKey'),
  expiry: $('expiry'), copied: $('copied'), again: $('again')
};

const MAX_BYTES = Number(els.maxBytes.textContent);
const encoder = new TextEncoder();

function formatDate(iso) {
  return new Date(iso).toLocaleString('pl-PL', { dateStyle: 'long', timeStyle: 'short' });
}

function renderExpiry(data) {
  const date = document.createElement('strong');
  date.className = 'expiry-date';
  date.textContent = formatDate(data.expiresAt);
  const prefix = data.burnAfterRead ? 'Wiadomość jednorazowa. Wygaśnie ' : 'Wiadomość wielokrotna. Wygaśnie ';
  const suffix = data.burnAfterRead ? ', jeśli nie zostanie wcześniej odczytana.' : '.';
  els.expiry.replaceChildren(prefix, date, suffix);
}

function showError(message) {
  els.formError.textContent = message;
  els.formError.classList.remove('hidden');
}

function clearError() {
  els.formError.textContent = '';
  els.formError.classList.add('hidden');
}

function updateCounter() {
  const size = encoder.encode(els.note.value).length;
  els.bytes.textContent = String(size);
  els.create.disabled = size === 0 || size > MAX_BYTES;
}

async function copyToClipboard(input) {
  try {
    await navigator.clipboard.writeText(input.value);
  } catch {
    input.focus();
    input.select();
    document.execCommand('copy');
  }
  els.copied.classList.remove('hidden');
  setTimeout(() => els.copied.classList.add('hidden'), 2000);
}

async function createNote() {
  clearError();
  const text = els.note.value;
  if (!text) return;
  els.create.disabled = true;

  try {
    const rawKey = generateRawKey();
    const { iv, ciphertext } = await encryptText(text, rawKey);
    const response = await fetch('/api/create', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ciphertext, iv, ttl: els.ttl.value, burnAfterRead: els.burn.checked })
    });

    if (response.status === 403) return showError('Twój adres IP nie ma uprawnień do tworzenia wiadomości.');
    if (response.status === 413 || response.status === 400) return showError('Wiadomość jest zbyt długa lub ma nieprawidłowy format.');
    if (!response.ok) return showError(`Serwer odpowiedział błędem (${response.status}).`);

    const data = await response.json();
    const keyStr = toBase64Url(rawKey);
    els.linkNoKey.value = `${location.origin}/${data.id}`;
    els.link.value = `${els.linkNoKey.value}#${keyStr}`;
    els.key.value = keyStr;
    renderExpiry(data);

    els.note.value = '';
    updateCounter();
    els.form.classList.add('hidden');
    els.result.classList.remove('hidden');
  } catch (err) {
    showError('Nie udało się utworzyć wiadomości. Sprawdź połączenie i spróbuj ponownie.');
  } finally {
    els.create.disabled = false;
  }
}

function reset() {
  els.link.value = '';
  els.linkNoKey.value = '';
  els.key.value = '';
  els.expiry.replaceChildren();
  els.result.classList.add('hidden');
  els.form.classList.remove('hidden');
  els.note.focus();
}

if (!hasWebCrypto()) {
  showError('Ta przeglądarka nie udostępnia Web Crypto. Strona wymaga HTTPS lub adresu localhost.');
  els.create.disabled = true;
} else {
  els.note.addEventListener('input', updateCounter);
  els.create.addEventListener('click', createNote);
  els.copyLink.addEventListener('click', () => copyToClipboard(els.link));
  els.copyLinkNoKey.addEventListener('click', () => copyToClipboard(els.linkNoKey));
  els.copyKey.addEventListener('click', () => copyToClipboard(els.key));
  els.again.addEventListener('click', reset);
  updateCounter();
}
