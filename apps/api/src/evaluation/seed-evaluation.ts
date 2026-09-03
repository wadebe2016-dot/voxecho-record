import { PrismaClient, Role } from '@prisma/client';
import { RETENTION_DAYS_DEFAULT } from '@voxecho/shared';
import { resoudreCheminDeDonnees } from '../config/chemins';
import { hashPassword } from '../auth/password';
import { compteEvaluation } from './comptes-evaluation';
import { deposerJeuDEvaluation, SLUG_EVALUATION } from './depots-evaluation';
import { appliquerDatabaseUrl } from '../config/database-url';

/**
 * Jeu d'évaluation de `record.voxecho.cm` — CLAUDE.md §9.18 et §9.21.
 *
 *   node apps/api/dist/evaluation/seed-evaluation.js
 *
 * Compilé, et non lancé par `tsx` : l'image de production est élaguée de ses
 * dépendances de développement, et un seed qui ne tournerait qu'en
 * développement ne servirait à rien le jour où il faut regarnir l'instance.
 *
 * Il **dépose** des appels dans `INGEST_DIR` plutôt que d'écrire des lignes en
 * base : c'est le chemin réel du produit, contrat §3 compris, qui les range,
 * les empreint et les scelle. Une instance remplie par des insertions directes
 * montrerait des enregistrements que l'ingestion n'a jamais vus — précisément
 * ce qu'un contrôleur ne doit pas trouver.
 *
 * Il est **idempotent** : relancé, il complète sans dupliquer.
 */

const prisma = new PrismaClient();

const LOCATAIRE = {
  name: 'Banque Méridienne',
  slug: SLUG_EVALUATION,
};

async function main(): Promise<void> {
  // Le point d'entrée de l'image construit DATABASE_URL ; une commande
  // d'exploitation le court-circuite et doit donc la construire aussi (§9.19).
  appliquerDatabaseUrl();
  const ingestDir = resoudreCheminDeDonnees(process.env.INGEST_DIR ?? './data/ingest');

  const comptes = [
    compteEvaluation(Role.ADMIN, 'EVAL_ADMIN', 'admin@banque-meridienne.cm', process.env),
    compteEvaluation(Role.AUDITOR, 'EVAL_AUDITOR', 'auditeur@banque-meridienne.cm', process.env),
    compteEvaluation(
      Role.SUPERVISOR,
      'EVAL_SUPERVISOR',
      'superviseur@banque-meridienne.cm',
      process.env,
    ),
  ];

  const locataire = await prisma.tenant.upsert({
    where: { slug: LOCATAIRE.slug },
    update: {},
    create: LOCATAIRE,
  });

  for (const { role, email, motDePasse } of comptes) {
    // L'ADMIN de l'instance d'évaluation administre aussi l'instance : sans
    // cela, la console d'administration ne serait ouverte à personne et il
    // faudrait un accès au serveur pour la déverrouiller (§9.22).
    const instanceAdmin = role === Role.ADMIN;
    await prisma.user.upsert({
      where: { email },
      update: { role, active: true, instanceAdmin },
      create: {
        tenantId: locataire.id,
        email,
        role,
        instanceAdmin,
        passwordHash: await hashPassword(motDePasse),
      },
    });
  }

  await prisma.retentionPolicy.upsert({
    where: { tenantId_appliesTo: { tenantId: locataire.id, appliesTo: 'all' } },
    update: {},
    create: { tenantId: locataire.id, appliesTo: 'all', days: RETENTION_DAYS_DEFAULT },
  });

  const dejaIngeres = await prisma.recording.count({ where: { tenantId: locataire.id } });
  if (dejaIngeres > 0) {
    console.warn(`Instance déjà garnie : ${dejaIngeres} appel(s). Aucun dépôt ajouté.`);
  } else {
    const depot = await deposerJeuDEvaluation({ ingestDir });
    console.warn(
      `${depot.appels} appel(s) et ${depot.quarantaines} dépôt(s) non conforme(s) déposés dans ${depot.repertoire}.`,
    );
    console.warn(
      "L'ingestion les rangera au prochain balayage (INGEST_POLL_MS) : le portail les montrera d'ici quelques secondes.",
    );
  }

  console.warn(`Locataire « ${LOCATAIRE.name} » et ${comptes.length} compte(s) en place.`);
  for (const { role, email } of comptes) console.warn(`  ${role.padEnd(11)} ${email}`);

  await prisma.$disconnect();
}

void main().catch(async (erreur: unknown) => {
  console.error(erreur instanceof Error ? erreur.message : erreur);
  await prisma.$disconnect();
  process.exitCode = 1;
});
