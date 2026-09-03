import { PrismaClient } from '@prisma/client';
import { appliquerDatabaseUrl } from '../config/database-url';
import { analyserArguments } from '../backup/arguments';

/**
 * Donne ou retire l'administration de l'instance — CLAUDE.md §9.22.
 *
 *   pnpm --filter @voxecho/api run admin:instance -- --lister
 *   pnpm --filter @voxecho/api run admin:instance -- --promouvoir admin@banque.cm
 *   pnpm --filter @voxecho/api run admin:instance -- --revoquer admin@banque.cm
 *
 * **En ligne de commande, jamais depuis le portail.** Un privilège qui se
 * donne depuis l'écran qu'il déverrouille ne protège de rien : un compte ADMIN
 * compromis s'attribuerait les pleins pouvoirs sur l'instance, et donc sur les
 * réglages qui décident de la valeur probante du journal (§9.16). Se le donner
 * exige un accès au serveur — le même niveau que celui qui a installé le
 * produit.
 */
async function main(): Promise<void> {
  appliquerDatabaseUrl();
  const arguments_ = analyserArguments(
    process.argv.slice(2),
    ['--promouvoir', '--revoquer'],
    ['--lister'],
  );
  const prisma = new PrismaClient();

  try {
    const promouvoir = arguments_.valeurs.get('--promouvoir');
    const revoquer = arguments_.valeurs.get('--revoquer');

    if (promouvoir !== undefined || revoquer !== undefined) {
      const email = (promouvoir ?? revoquer ?? '').trim().toLowerCase();
      const compte = await prisma.user.findUnique({
        where: { email },
        select: { id: true, email: true, role: true, active: true, instanceAdmin: true },
      });
      if (!compte) throw new Error(`Aucun compte pour ${email}.`);

      if (promouvoir !== undefined && compte.role !== 'ADMIN') {
        // On n'ajoute pas un privilège d'instance à qui n'administre même pas
        // son locataire : ce serait un chemin détourné vers les pleins droits.
        throw new Error(
          `${email} a le rôle ${compte.role} : l’administration de l’instance suppose le rôle ADMIN.`,
        );
      }
      if (promouvoir !== undefined && !compte.active) {
        throw new Error(`${email} est désactivé : le réactiver avant de le promouvoir.`);
      }

      await prisma.user.update({
        where: { id: compte.id },
        data: { instanceAdmin: promouvoir !== undefined },
      });
      console.warn(
        promouvoir !== undefined
          ? `${email} administre désormais l’instance.`
          : `${email} n’administre plus l’instance.`,
      );
      console.warn(
        'Le privilège voyage dans le jeton d’accès : le changement prend effet au prochain jeton (JWT_ACCESS_TTL).',
      );
    }

    const administrateurs = await prisma.user.findMany({
      where: { instanceAdmin: true },
      orderBy: { email: 'asc' },
      select: { email: true, active: true, tenant: { select: { name: true } } },
    });

    console.warn('');
    console.warn(`Administrateur(s) de l’instance : ${administrateurs.length}`);
    for (const administrateur of administrateurs) {
      console.warn(
        `  ${administrateur.email}${administrateur.active ? '' : ' (désactivé)'} — ${administrateur.tenant.name}`,
      );
    }
    if (administrateurs.length === 0) {
      // Une instance sans administrateur n'est pas une instance sûre : elle
      // est une instance qu'on ne peut plus régler sans accès au serveur.
      console.warn('  aucun — la console d’administration n’est ouverte à personne.');
    }
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((erreur: unknown) => {
  console.error(erreur instanceof Error ? erreur.message : erreur);
  process.exitCode = 1;
});
