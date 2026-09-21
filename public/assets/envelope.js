export const ENVELOPE_VERSION = 1;

export function packEnvelope({ text, file }) {
  return JSON.stringify({
    v: ENVELOPE_VERSION,
    text: text ?? '',
    file: file ? { name: file.name, type: file.type || 'application/octet-stream', size: file.size } : null
  });
}

export function unpackEnvelope(plaintext) {
  try {
    const parsed = JSON.parse(plaintext);
    if (parsed && parsed.v === ENVELOPE_VERSION && typeof parsed.text === 'string') {
      return { text: parsed.text, file: parsed.file && typeof parsed.file.name === 'string' ? parsed.file : null };
    }
  } catch {}
  return { text: plaintext, file: null };
}

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
