/**
 * Peuple une base d'essai avec ce qui compte pour une migration —
 * CLAUDE.md §9.30.
 *
 * Pas un jeu de démonstration : une ligne dans chaque table qu'une migration
 * risque de contraindre. C'est la présence de la ligne qui fait échouer un
 * `ADD COLUMN NOT NULL` sans défaut, pas son contenu.
 *
 * Écrit en SQL et non avec Prisma : le client est généré pour le schéma
 * **actuel**, alors que la base d'essai est volontairement en retard d'une
 * migration.
 */
import { execFileSync } from 'node:child_process';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL absente.');
  process.exit(1);
}

/** L'url sans les paramètres de Prisma, que libpq refuse. */
const cible = (() => {
  const analysee = new URL(url);
  analysee.search = '';
  return analysee.toString();
})();

const SQL = `
INSERT INTO tenants (id, name, slug, active, created_at)
VALUES ('11111111-1111-1111-1111-111111111111', 'Banque d''essai', 'banque-essai', true, now());

INSERT INTO users (id, tenant_id, email, password_hash, role, active, created_at, failed_login_attempts)
VALUES ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111',
        'essai@banque-essai.cm', 'argon2-fictif', 'ADMIN', true, now(), 0);

INSERT INTO recordings (id, tenant_id, refci, near, far, direction, started_at, duration_sec,
                        file_path, sha256, size_bytes, source, status, created_at)
VALUES ('33333333-3333-3333-3333-333333333333', '11111111-1111-1111-1111-111111111111',
        '16778001', '1001', '699112233', 'outbound', now() - interval '400 days', 120,
        '11111111-1111-1111-1111-111111111111/2025/07/essai.wav', repeat('a', 64), 1920000,
        'simulator', 'stored', now());

INSERT INTO legal_holds (id, tenant_id, recording_id, set_by, reason, at)
VALUES ('44444444-4444-4444-4444-444444444444', '11111111-1111-1111-1111-111111111111',
        '33333333-3333-3333-3333-333333333333', '22222222-2222-2222-2222-222222222222',
        'Conservation antérieure à l''exigence de référence de dossier', now());

INSERT INTO retention_policies (id, tenant_id, days, applies_to, updated_at)
VALUES ('55555555-5555-5555-5555-555555555555', '11111111-1111-1111-1111-111111111111',
        730, 'all', now());

INSERT INTO audit_events (id, tenant_id, user_id, action, ip, at)
VALUES ('66666666-6666-6666-6666-666666666666', '11111111-1111-1111-1111-111111111111',
        '22222222-2222-2222-2222-222222222222', 'LOGIN', '10.0.0.1', now());
`;

try {
  execFileSync('psql', [cible, '-v', 'ON_ERROR_STOP=1', '-q', '-c', SQL], { stdio: 'pipe' });
  console.log('   locataire, compte, appel, conservation forcée, politique, journal');
} catch (erreur) {
  const details = erreur.stderr?.toString() ?? String(erreur);
  // Une table absente signifie que la base d'essai est plus en retard que
  // prévu : on le dit plutôt que d'échouer sur un message de psql.
  console.error(`Peuplement impossible : ${details.trim()}`);
  process.exit(1);
}
