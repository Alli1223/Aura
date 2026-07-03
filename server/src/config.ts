import { z } from 'zod';

const envSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(8096),
  /**
   * Directory for persistent server state (DB, cache, transcodes, secrets).
   * Defaults to ./config so development boots without root permissions;
   * the Docker image sets CONFIG_DIR=/config (the mounted config volume).
   */
  CONFIG_DIR: z.string().min(1).default('./config'),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  // Directory containing the built web app. Only served if it exists, so the
  // default is harmless in development (Vite serves the web app instead).
  WEB_DIST: z.string().min(1).default('/app/web/dist'),
});

export type Config = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    throw new Error(`Invalid environment configuration: ${result.error.message}`);
  }
  return result.data;
}

export const config = loadConfig();
