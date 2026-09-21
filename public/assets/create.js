import { toBase64Url } from './base64url.js';
import { encryptBytes, encryptText, generateRawKey, hasWebCrypto } from './crypto.js';
import { formatBytes, packEnvelope } from './envelope.js';

const $ = (id) => document.getElementById(id);
const els = {
  form: $('form'), result: $('result'), note: $('note'), bytes: $('bytes'), maxBytes: $('maxBytes'),
  file: $('file'), clearFile: $('clearFile'), fileInfo: $('fileInfo'), maxUploadLabel: $('maxUploadLabel'),
  ttl: $('ttl'), burn: $('burn'), create: $('create'), formError: $('formError'),
  link: $('link'), linkNoKey: $('linkNoKey'), key: $('key'),
  copyLink: $('copyLink'), copyLinkNoKey: $('copyLinkNoKey'), copyKey: $('copyKey'),
  expiry: $('expiry'), copied: $('copied'), again: $('again')
};

const MAX_BYTES = Number(els.maxBytes.textContent);
const MAX_UPLOAD = Number(document.querySelector('.filerow').dataset.maxUpload);
const FRAME_CONTENT_TYPE = 'application/x-skrytka-note';
let selectedFile = null;
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
  els.create.disabled = (size === 0 && !selectedFile) || size > MAX_BYTES;
}

function setFile(file) {
  if (file && file.size > MAX_UPLOAD) {
    showError(`Plik jest zbyt duży. Limit to ${formatBytes(MAX_UPLOAD)}.`);
    els.file.value = '';
    selectedFile = null;
  } else {
    clearError();
    selectedFile = file || null;
  }
  els.clearFile.classList.toggle('hidden', !selectedFile);
  els.fileInfo.textContent = selectedFile
    ? `${selectedFile.name} (${formatBytes(selectedFile.size)}), zostanie zaszyfrowany w przeglądarce razem z nazwą.`
    : 'Plik zostanie zaszyfrowany w przeglądarce razem z nazwą.';
  updateCounter();
}

function buildFrame(meta, encryptedFile) {
  const metaBytes = encoder.encode(JSON.stringify(meta));
  const header = new Uint8Array(4);
  new DataView(header.buffer).setUint32(0, metaBytes.byteLength, false);
  return new Blob([header, metaBytes, encryptedFile], { type: FRAME_CONTENT_TYPE });
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
  if (!text && !selectedFile) return;
  els.create.disabled = true;
  els.create.textContent = selectedFile ? 'Szyfrowanie i wysyłanie...' : 'Szyfrowanie...';

  try {
    const rawKey = generateRawKey();
    const { iv, ciphertext } = await encryptText(packEnvelope({ text, file: selectedFile }), rawKey);
    const meta = { ciphertext, iv, ttl: els.ttl.value, burnAfterRead: els.burn.checked };
    let response;
    if (selectedFile) {
      const encryptedFile = await encryptBytes(new Uint8Array(await selectedFile.arrayBuffer()), rawKey);
      response = await fetch('/api/create', { method: 'POST', headers: { 'content-type': FRAME_CONTENT_TYPE }, body: buildFrame(meta, encryptedFile) });
    } else {
      response = await fetch('/api/create', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(meta) });
    }

    if (response.status === 403) return showError('Twój adres IP nie ma uprawnień do tworzenia wiadomości.');
    if (response.status === 507) return showError('Skrytka jest pełna. Spróbuj później albo wyślij wiadomość bez załącznika.');
    if (response.status === 413) return showError(`Wiadomość lub plik jest zbyt duży. Limit załącznika to ${formatBytes(MAX_UPLOAD)}.`);
    if (response.status === 400) return showError('Wiadomość ma nieprawidłowy format.');
    if (response.status === 429) return showError('Zbyt wiele wiadomości w krótkim czasie. Odczekaj chwilę.');
    if (!response.ok) return showError(`Serwer odpowiedział błędem (${response.status}).`);

    const data = await response.json();
    const keyStr = toBase64Url(rawKey);
    els.linkNoKey.value = `${location.origin}/${data.id}`;
    els.link.value = `${els.linkNoKey.value}#${keyStr}`;
    els.key.value = keyStr;
    renderExpiry(data);

    els.note.value = '';
    els.file.value = '';
    setFile(null);
    els.form.classList.add('hidden');
    els.result.classList.remove('hidden');
  } catch (err) {
    showError('Nie udało się utworzyć wiadomości. Sprawdź połączenie i spróbuj ponownie.');
  } finally {
    els.create.textContent = 'Utwórz link';
    updateCounter();
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
  els.maxUploadLabel.textContent = formatBytes(MAX_UPLOAD);
  els.note.addEventListener('input', updateCounter);
  els.file.addEventListener('change', () => setFile(els.file.files[0]));
  els.clearFile.addEventListener('click', () => { els.file.value = ''; setFile(null); });
  els.create.addEventListener('click', createNote);
  els.copyLink.addEventListener('click', () => copyToClipboard(els.link));
  els.copyLinkNoKey.addEventListener('click', () => copyToClipboard(els.linkNoKey));
  els.copyKey.addEventListener('click', () => copyToClipboard(els.key));
  els.again.addEventListener('click', reset);
  updateCounter();
}
