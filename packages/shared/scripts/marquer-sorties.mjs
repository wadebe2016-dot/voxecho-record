import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * `packages/shared` est émis deux fois : CommonJS pour l'api et les outils
 * Node, ESM pour le portail. Node décide du format d'un `.js` d'après le
 * `type` du package.json le plus proche ; sans ces deux marqueurs, les deux
 * sorties seraient lues comme du CommonJS et l'ESM ne se chargerait pas.
 */
const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');

await Promise.all([
  writeFile(join(dist, 'cjs', 'package.json'), `${JSON.stringify({ type: 'commonjs' }, null, 2)}\n`),
  writeFile(join(dist, 'esm', 'package.json'), `${JSON.stringify({ type: 'module' }, null, 2)}\n`),
]);
