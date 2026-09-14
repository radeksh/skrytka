const CHECKPOINT_EVERY_RUNS = 1440;

export function startCleanup({ db, intervalMs, now, log }) {
  let runs = 0;
  const run = () => {
    try {
      const deleted = db.deleteExpired(now());
      if (deleted) log.info({ deleted }, 'expired notes removed');
      runs += 1;
      if (runs % CHECKPOINT_EVERY_RUNS === 0) db.checkpoint();
    } catch (err) {
      log.error(err, 'cleanup failed');
    }
  };
  run();
  const timer = setInterval(run, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
