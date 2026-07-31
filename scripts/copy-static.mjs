// Copies the admin UI static assets into dist/ after tsc.
import { cp, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const pairs = [
  ['src/web/public', 'dist/web/public'],
  ['src/db/schema.sql', 'dist/db/schema.sql'],
];

for (const [from, to] of pairs) {
  await mkdir(dirname(resolve(root, to)), { recursive: true });
  await cp(resolve(root, from), resolve(root, to), { recursive: true });
  console.log(`copied ${from} -> ${to}`);
}
