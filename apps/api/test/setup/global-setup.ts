import { migrateTestSchema } from '../helpers/database';

/**
 * Prépare un schéma par worker Jest, avant l'ensemble de la suite. Le nombre
 * de workers dépend de la machine : deux cœurs en local, quatre sur un
 * runner. Migrer d'après `maxWorkers` évite qu'une suite tombe sur un schéma
 * qui n'existe pas — et que les workers se partagent le même.
 */
export default function globalSetup(config: { maxWorkers?: number }): void {
  const workers = Math.max(1, config.maxWorkers ?? 1);
  for (let worker = 1; worker <= workers; worker += 1) {
    migrateTestSchema(`test_${worker}`);
  }
}
