const CHECKPOINT_EVERY_RUNS = 1440;

export function startCleanup({ db, files, intervalMs, now, log }) {
  let runs = 0;
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      const { deletedNotes, orphanKeys } = db.sweepExpired(now());
      for (const key of orphanKeys) await files.remove(key).catch((err) => log.warn({ err, key }, 'file removal failed'));
      if (deletedNotes || orphanKeys.length) log.info({ deletedNotes, deletedFiles: orphanKeys.length }, 'expired data removed');
      runs += 1;
      if (runs % CHECKPOINT_EVERY_RUNS === 0) db.checkpoint();
    } catch (err) {
      log.error(err, 'cleanup failed');
    } finally {
      running = false;
    }
  };
  run();
  const timer = setInterval(run, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
