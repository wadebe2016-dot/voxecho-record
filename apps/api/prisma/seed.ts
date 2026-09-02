import { PrismaClient, Role } from '@prisma/client';
import { RETENTION_DAYS_DEFAULT } from '@voxecho/shared';
import { hashPassword } from '../src/auth/password';

/**
 * Jeu de données de démarrage : deux locataires, pour que le cloisonnement
 * soit visible dès le premier lancement, et un compte par rôle.
 * Les mots de passe sont ceux d'un environnement de développement — ils
 * n'ont pas vocation à exister ailleurs.
 */
const prisma = new PrismaClient();

const MOT_DE_PASSE_DEMO = 'Demo!2026';

interface GraineUtilisateur {
  email: string;
  role: Role;
}

interface GraineLocataire {
  name: string;
  /** Sous-répertoire surveillé par l'ingestion : `INGEST_DIR/<slug>/`. */
  slug: string;
  users: GraineUtilisateur[];
  /**
   * Conservation du locataire. Omise, c'est le défaut du produit qui
   * s'applique — 730 jours, deux ans (CLAUDE.md §9.6). Les deux locataires de
   * démonstration gardent des durées plus longues : elles montrent que la
   * valeur se règle par locataire, et elles restent au-dessus du plancher.
   */
  retentionDays?: number;
}

const LOCATAIRES: GraineLocataire[] = [
  {
    name: 'Banque de démonstration CEMAC',
    slug: 'banque-cemac',
    retentionDays: 3650,
    users: [
      { email: 'admin@demo.cm', role: Role.ADMIN },
      { email: 'superviseur@demo.cm', role: Role.SUPERVISOR },
      { email: 'auditeur@demo.cm', role: Role.AUDITOR },
    ],
  },
  {
    name: 'Microfinance Témoin',
    slug: 'microfinance-temoin',
    retentionDays: 1825,
    users: [{ email: 'admin@temoin.cm', role: Role.ADMIN }],
  },
];

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Le seed de démonstration ne doit pas être exécuté en production.');
  }

  const passwordHash = await hashPassword(MOT_DE_PASSE_DEMO);

  for (const graine of LOCATAIRES) {
    const tenant = await prisma.tenant.upsert({
      where: { name: graine.name },
      update: { slug: graine.slug },
      create: { name: graine.name, slug: graine.slug },
    });

    for (const utilisateur of graine.users) {
      await prisma.user.upsert({
        where: { email: utilisateur.email },
        update: { tenantId: tenant.id, role: utilisateur.role, active: true },
        create: {
          tenantId: tenant.id,
          email: utilisateur.email,
          passwordHash,
          role: utilisateur.role,
        },
      });
    }

    const jours = graine.retentionDays ?? RETENTION_DAYS_DEFAULT;
    await prisma.retentionPolicy.upsert({
      where: { tenantId_appliesTo: { tenantId: tenant.id, appliesTo: 'all' } },
      update: { days: jours },
      create: { tenantId: tenant.id, days: jours, appliesTo: 'all' },
    });

    console.warn(
      `Locataire « ${graine.name} » : ${graine.users.length} compte(s), rétention ${jours} j`,
    );
  }

  console.warn(`Mot de passe de démonstration pour tous les comptes : ${MOT_DE_PASSE_DEMO}`);
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
