import { buildApp } from './app.js';
import { config } from './config.js';
import { seedDefaultLibraries } from './lib/seed-libraries.js';

const app = buildApp({ logger: true }, { webDistDir: config.WEB_DIST });

// Best-effort first-run convenience: a failure here (e.g. the database has
// not been migrated yet) must never prevent the server from starting.
try {
  await seedDefaultLibraries(config.MEDIA_ROOTS, app.log);
} catch (err) {
  app.log.error(err, 'failed to seed default libraries');
}

try {
  await app.listen({ port: config.PORT, host: '0.0.0.0' });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
