import { createReadStream } from 'node:fs';
import { mkdir, open, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

const KEY_RE = /^[0-9a-f-]{36}$/;

export function createFileStore(dir) {
  const pathFor = (key) => {
    if (!KEY_RE.test(key)) throw new Error('invalid file key');
    return join(dir, key);
  };

  return {
    async init() {
      await mkdir(dir, { recursive: true });
    },
    async writeFrom(key, chunks, expectedLength) {
      const tmp = `${pathFor(key)}.tmp`;
      const handle = await open(tmp, 'w');
      let written = 0;
      try {
        for await (const chunk of chunks) {
          written += chunk.byteLength;
          if (written > expectedLength) throw new RangeError('file exceeds declared length');
          await handle.write(chunk);
        }
        if (written !== expectedLength) throw new RangeError('file shorter than declared length');
        await handle.close();
        await rename(tmp, pathFor(key));
      } catch (err) {
        await handle.close().catch(() => {});
        await rm(tmp, { force: true });
        throw err;
      }
    },
    async size(key) {
      try {
        return (await stat(pathFor(key))).size;
      } catch {
        return null;
      }
    },
    stream(key) {
      return createReadStream(pathFor(key));
    },
    async remove(key) {
      await rm(pathFor(key), { force: true });
    }
  };
}
