import { readFileSync } from 'node:fs';

interface PackageJson {
  version: string;
}

// Resolves to server/package.json from both src/ (tsx) and dist/ (compiled).
const pkg = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as PackageJson;

export const appVersion = pkg.version;
