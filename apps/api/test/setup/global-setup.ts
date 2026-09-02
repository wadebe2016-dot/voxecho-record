import { migrateTestSchema } from '../helpers/database';

/** Prépare le schéma `test` avant l'ensemble de la suite. */
export default function globalSetup(): void {
  migrateTestSchema();
}
