import { buildApp } from './app.js';
import { config } from './config.js';
import { seedDefaultLibraries } from './lib/seed-libraries.js';

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

try {
  await app.listen({ port: config.PORT, host: '0.0.0.0' });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
