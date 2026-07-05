import { buildApp } from './app.js';
import { config } from './config.js';
import { seedDefaultLibraries } from './lib/seed-libraries.js';
import { LibraryWatcher, setActiveLibraryWatcher } from './scanner/library-watcher.js';
import { createBuiltInTasks } from './tasks/built-in-tasks.js';
import { setActiveTaskRunner, TaskRunner } from './tasks/task-runner.js';

const app = buildApp({ logger: true }, { webDistDir: config.WEB_DIST });

// Best-effort first-run convenience. In production the container entrypoint
// runs `prisma migrate deploy` before this process starts, so the schema is
// guaranteed to exist; in development the database may not be migrated yet,
// so a failure here must never prevent the server from starting.
try {
  await seedDefaultLibraries(config.MEDIA_ROOTS, app.log);
} catch (err) {
  app.log.error(
    err,
    'failed to seed default libraries — is the database migrated? (run `npm run db:deploy` in server/)',
  );
}

// Near-realtime library updates: watch every library's folders and trigger a
// debounced per-library rescan when they change. Disabled under NODE_ENV=test
// and behind WATCH_ENABLED; a boot with no media dirs simply watches nothing.
const watcher = config.WATCH_ENABLED
  ? new LibraryWatcher({
      mediaRoots: config.MEDIA_ROOTS,
      debounceMs: config.WATCH_DEBOUNCE_MS,
      log: app.log,
    })
  : null;
if (watcher !== null) {
  setActiveLibraryWatcher(watcher);
  try {
    await watcher.start();
  } catch (err) {
    app.log.error(err, 'failed to start the library watcher');
  }
}

// Periodic maintenance task runner. This subsumes the old standalone
// ScanScheduler: the `library-scan-all` task runs scanAllLibraries on
// SCAN_INTERVAL_MS (0 disables just that task) as a safety-net rescan, alongside
// transcode/artwork cleanup and DB backup. Started only when TASKS_ENABLED
// (disabled by default under NODE_ENV=test); the timers are unref'd so they
// never keep the process alive.
const taskRunner = new TaskRunner({ log: app.log });
for (const task of createBuiltInTasks({ config, log: app.log })) {
  taskRunner.register(task);
}
setActiveTaskRunner(taskRunner);
if (config.TASKS_ENABLED) taskRunner.start();

// Stop the watcher and task runner cleanly whenever the server closes.
app.addHook('onClose', async () => {
  taskRunner.stop();
  setActiveTaskRunner(null);
  setActiveLibraryWatcher(null);
  await watcher?.stop();
});

let shuttingDown = false;
const shutdown = (signal: NodeJS.Signals): void => {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, 'received shutdown signal, closing server');
  app
    .close()
    .then(() => process.exit(0))
    .catch((err: unknown) => {
      app.log.error(err, 'error during shutdown');
      process.exit(1);
    });
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

try {
  await app.listen({ port: config.PORT, host: '0.0.0.0' });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
