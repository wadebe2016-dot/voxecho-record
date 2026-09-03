/**
 * Construction de l'URL de connexion PostgreSQL — CLAUDE.md §9.19.
 *
 * Le compose assemblait l'URL par concaténation :
 *
 *   postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@db:5432/${POSTGRES_DB}
 *
 * Un mot de passe tiré au hasard contient tôt ou tard `/`, `+`, `=` ou `@`.
 * Le premier `/` referme la partie autorité de l'URL, et Prisma refuse de
 * démarrer sur un « invalid port number » qui ne dit rien du vrai problème :
 * l'api redémarre en boucle pendant qu'on cherche du côté du port.
 *
 * L'URL est donc construite ici, en pourcent-encodant l'identifiant et le mot
 * de passe. Générer des secrets sans caractère gênant reste préférable — et le
 * runbook le fait — mais s'en remettre à cela seul reviendrait à interdire à
 * un exploitant de choisir son propre mot de passe sans le lui dire.
 */

export interface PartiesConnexion {
  user: string;
  password: string;
  host: string;
  port: number | string;
  database: string;
  schema?: string;
}

/**
 * Force la session PostgreSQL en UTC — CLAUDE.md §9.27.
 *
 * Les colonnes d'horodatage sont des `timestamp` sans fuseau, et celles qui
 * portent `DEFAULT CURRENT_TIMESTAMP` — `audit_events.at`, tous les
 * `created_at` — prennent la valeur **du fuseau de la session**. Une base
 * réglée sur Africa/Douala y écrit donc 13 h 56 quand il est 12 h 56 UTC ;
 * l'api relit cette colonne comme de l'UTC, et le portail affiche 14 h 56.
 * Une heure de trop dans un journal qu'on ne peut pas corriger.
 *
 * Le produit ne s'en remet pas au réglage du serveur : il l'impose à sa
 * connexion. Un client fournira sa propre base, et son fuseau ne nous regarde
 * pas — c'est ce que nous y écrivons qui doit être juste.
 */
export function avecFuseauUtc(url: string): string {
  const cible = new URL(url);
  // Une déclaration explicite de l'exploitant l'emporte : s'il a réglé
  // `options` lui-même, on ne le contredit pas dans son dos — le contrôle au
  // démarrage refusera de toute façon une session qui n'est pas en UTC.
  if (cible.searchParams.has('options')) return url;

  // Écrit à la main, et non par `URLSearchParams` : celui-ci encode l'espace
  // en `+`, que libpq lit littéralement — `pg_dump` refusait alors de se
  // connecter sur « unrecognized configuration parameter "+timezone" ».
  return `${url}${url.includes('?') ? '&' : '?'}options=-c%20timezone%3DUTC`;
}

export function construireDatabaseUrl(parties: PartiesConnexion): string {
  const identite = `${encodeURIComponent(parties.user)}:${encodeURIComponent(parties.password)}`;
  const base = `postgresql://${identite}@${parties.host}:${parties.port}/${encodeURIComponent(parties.database)}`;
  return avecFuseauUtc(`${base}?schema=${encodeURIComponent(parties.schema ?? 'public')}`);
}

/**
 * L'URL de connexion telle qu'elle doit être utilisée : celle qui est fournie
 * si elle l'est, sinon celle qu'on assemble à partir des composants.
 *
 * Une `DATABASE_URL` explicite l'emporte toujours : c'est ce que fournissent le
 * développement et la CI, et un déploiement qui la donne entière ne doit pas
 * voir sa valeur reconstruite dans son dos.
 */
export function databaseUrlDepuisEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  const fournie = env.DATABASE_URL?.trim();
  if (fournie) return avecFuseauUtc(fournie);

  const user = env.POSTGRES_USER?.trim();
  const password = env.POSTGRES_PASSWORD ?? '';
  const database = env.POSTGRES_DB?.trim();
  if (!user || !database) return null;

  return construireDatabaseUrl({
    user,
    password,
    host: env.POSTGRES_HOST?.trim() || 'db',
    port: env.POSTGRES_PORT?.trim() || 5432,
    database,
    schema: env.POSTGRES_SCHEMA?.trim() || 'public',
  });
}

/**
 * Pose `DATABASE_URL` dans l'environnement si elle manque. Appelée en tête des
 * commandes d'exploitation, qui court-circuitent le point d'entrée de l'image
 * et n'auraient donc pas l'URL que celui-ci construit.
 */
export function appliquerDatabaseUrl(env: NodeJS.ProcessEnv = process.env): void {
  const url = databaseUrlDepuisEnv(env);
  if (url !== null) env.DATABASE_URL = url;
}

// Exécuté directement, le module imprime l'URL : c'est ainsi que le point
// d'entrée de l'image l'obtient, sans réécrire l'encodage en shell.
if (require.main === module) {
  const url = databaseUrlDepuisEnv();
  if (url === null) {
    process.stderr.write(
      'DATABASE_URL absente, et POSTGRES_USER / POSTGRES_DB ne suffisent pas à la construire.\n',
    );
    process.exit(1);
  }
  process.stdout.write(url);
}
