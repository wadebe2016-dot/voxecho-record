import type { PrismaClient } from '@prisma/client';
import { parcourirInventaire, type LigneInventaire } from './inventaire';
import { constatVide, noter, type Constat } from './constat';
import { etatDesMigrations } from './sauvegarde.service';
import type { Manifeste } from './manifeste';

/**
 * Constat d'après-restauration — CLAUDE.md §9.15.
 *
 * `verification.service` va aussi loin qu'on peut aller **sans** restaurer :
 * la prise concorde-t-elle avec son manifeste, détient-on la bonne clé, le
 * disque contient-il ce que l'inventaire annonce. Restait le dernier pas, et
 * c'est celui qui compte le jour d'un sinistre : la base qu'on vient de
 * remonter rend-elle exactement ce qui avait été sauvegardé ?
 *
 * `pg_restore` dit qu'il a fini, pas qu'il a tout rendu — une table restaurée
 * à moitié, un `--schema` de travers, un dump plus ancien qu'on ne croyait se
 * découvriraient sinon des mois plus tard, à la première pièce réclamée par un
 * contrôleur. Le manifeste et l'inventaire disent ce qui doit s'y trouver :
 * autant le leur demander pendant que l'exploitant est encore devant sa
 * console.
 *
 * La comparaison se fait par lots d'identifiants, jamais en chargeant
 * l'inventaire : un stockage de plusieurs centaines de milliers d'appels doit
 * pouvoir se constater sur une machine de secours.
 */

/** Lot d'identifiants confrontés à la base en une requête. */
const LOT = 500;

/**
 * Où en est la base par rapport à la prise.
 *
 * Restaurer un dump puis appliquer les migrations parues depuis est une
 * manœuvre normale : la base est alors **plus avancée** que la prise, et le
 * dire « divergent » ferait crier au sinistre sur une opération saine. Une
 * base **en retard**, elle, ne peut pas accueillir ce dump ; et une lignée
 * de migrations qui n'est pas la même n'est tout simplement pas cette
 * instance-là.
 */
export type EtatMigration = 'conforme' | 'base plus avancée' | 'base en retard' | 'autre lignée';

export interface RapportBaseRestauree {
  /** URL de la base constatée, mot de passe retiré. */
  cible: string;
  migration: {
    attendue: string | null;
    trouvee: string | null;
    appliquees: number;
    attendues: number;
    etat: EtatMigration;
  };
  locataires: { attendus: number; trouves: number; divergents: Constat };
  pieces: {
    /** Lignes de l'inventaire, purgées comprises : toutes doivent revenir. */
    attendues: number;
    retrouvees: number;
    absentes: Constat;
    divergentes: Constat;
    /** Enregistrements présents en base qu'aucune ligne d'inventaire ne décrit. */
    enTrop: number;
  };
  /** Ce qui empêche de tenir la restauration pour fidèle. Vide = fidèle. */
  anomalies: string[];
  fidele: boolean;
}

/** L'URL de la base telle qu'on peut l'afficher : sans le mot de passe. */
export function cibleLisible(brut: string): string {
  try {
    const url = new URL(brut);
    url.password = '';
    url.username = url.username ? url.username : '';
    return url.toString();
  } catch {
    return 'base désignée par DATABASE_URL';
  }
}

/** Ce que la base retient d'une pièce, dans la forme de l'inventaire. */
function commeInventaire(piece: {
  id: string;
  tenantId: string;
  filePath: string;
  sha256: string;
  sizeBytes: bigint;
  status: string;
  encrypted: boolean;
  keyRef: string | null;
}): LigneInventaire {
  return {
    id: piece.id,
    tenantId: piece.tenantId,
    chemin: piece.filePath,
    sha256: piece.sha256,
    octets: Number(piece.sizeBytes),
    statut: piece.status,
    scellee: piece.encrypted,
    cle: piece.keyRef,
  };
}

/** Ce qui, dans une ligne, ne concorde pas — pour dire quoi, pas seulement que. */
function ecarts(attendue: LigneInventaire, trouvee: LigneInventaire): string[] {
  const champs: [string, unknown, unknown][] = [
    ['locataire', attendue.tenantId, trouvee.tenantId],
    ['chemin', attendue.chemin, trouvee.chemin],
    ['empreinte', attendue.sha256, trouvee.sha256],
    ['taille', attendue.octets, trouvee.octets],
    ['statut', attendue.statut, trouvee.statut],
    ['scellée', attendue.scellee, trouvee.scellee],
    ['clé', attendue.cle, trouvee.cle],
  ];
  return champs
    .filter(([, attendu, trouve]) => attendu !== trouve)
    .map(([nom, attendu, trouve]) => `${nom} ${String(trouve)} au lieu de ${String(attendu)}`);
}

export interface OptionsBaseRestauree {
  prisma: PrismaClient;
  manifeste: Manifeste;
  cheminInventaire: string;
  cible: string;
}

export async function verifierBaseRestauree(
  options: OptionsBaseRestauree,
): Promise<RapportBaseRestauree> {
  const { prisma, manifeste } = options;

  const anomalies: string[] = [];
  const migrations = await etatDesMigrations(prisma);
  const migration = {
    attendue: manifeste.base.derniereMigration,
    trouvee: migrations.derniere,
    appliquees: migrations.total,
    attendues: manifeste.base.migrationsAppliquees,
    etat: etatDeMigration(migrations, manifeste),
  };
  if (migration.etat === 'base en retard' || migration.etat === 'autre lignée') {
    anomalies.push(
      `Migrations : ${migration.etat} — ${migration.appliquees} appliquée(s) en base ` +
        `(dernière « ${migration.trouvee ?? 'aucune'} »), ${migration.attendues} attendue(s) ` +
        `(« ${migration.attendue ?? 'aucune'} »).`,
    );
  }

  const comptes = await prisma.recording.groupBy({ by: ['tenantId'], _count: { _all: true } });
  const piecesParLocataire = new Map(comptes.map((ligne) => [ligne.tenantId, ligne._count._all]));
  const locataires = await prisma.tenant.findMany({
    orderBy: { slug: 'asc' },
    select: { id: true, slug: true, name: true, active: true },
  });
  const parId = new Map(locataires.map((locataire) => [locataire.id, locataire]));

  const divergents = constatVide();
  for (const attendu of manifeste.locataires) {
    const trouve = parId.get(attendu.id);
    if (!trouve) {
      noter(divergents, `${attendu.slug} : absent de la base restaurée`);
      continue;
    }
    parId.delete(attendu.id);
    const pieces = piecesParLocataire.get(attendu.id) ?? 0;
    if (trouve.slug !== attendu.slug || trouve.name !== attendu.nom) {
      noter(divergents, `${attendu.slug} : désigné « ${trouve.name} » (${trouve.slug}) en base`);
    }
    if (trouve.active !== attendu.actif) {
      noter(divergents, `${attendu.slug} : ${trouve.active ? 'actif' : 'désactivé'} en base`);
    }
    if (pieces !== attendu.pieces) {
      noter(
        divergents,
        `${attendu.slug} : ${pieces} pièce(s) en base, ${attendu.pieces} attendue(s)`,
      );
    }
  }
  for (const reste of parId.values()) {
    noter(divergents, `${reste.slug} : locataire en base que le manifeste ne connaît pas`);
  }
  if (divergents.total > 0) {
    anomalies.push(`${divergents.total} écart(s) sur les locataires.`);
  }

  const pieces: RapportBaseRestauree['pieces'] = {
    attendues: 0,
    retrouvees: 0,
    absentes: constatVide(),
    divergentes: constatVide(),
    enTrop: 0,
  };

  let lot: LigneInventaire[] = [];
  const confronter = async (): Promise<void> => {
    if (lot.length === 0) return;
    const trouvees = await prisma.recording.findMany({
      where: { id: { in: lot.map((ligne) => ligne.id) } },
      select: {
        id: true,
        tenantId: true,
        filePath: true,
        sha256: true,
        sizeBytes: true,
        status: true,
        encrypted: true,
        keyRef: true,
      },
    });
    const parPiece = new Map(trouvees.map((piece) => [piece.id, commeInventaire(piece)]));
    for (const attendue of lot) {
      const trouvee = parPiece.get(attendue.id);
      if (!trouvee) {
        noter(pieces.absentes, attendue.chemin);
        continue;
      }
      const differences = ecarts(attendue, trouvee);
      if (differences.length === 0) pieces.retrouvees += 1;
      else noter(pieces.divergentes, `${attendue.chemin} (${differences.join(', ')})`);
    }
    lot = [];
  };

  for await (const ligne of parcourirInventaire(options.cheminInventaire)) {
    pieces.attendues += 1;
    lot.push(ligne);
    if (lot.length >= LOT) await confronter();
  }
  await confronter();

  // Les enregistrements que l'inventaire ne décrit pas se comptent, ils ne
  // s'énumèrent pas : les désigner demanderait de tenir tout l'inventaire en
  // mémoire, ce que la réserve du §9.14 refuse déjà pour le stockage. Le
  // nombre suffit à savoir qu'on ne regarde pas la base qu'on croit.
  const enBase = await prisma.recording.count();
  pieces.enTrop = Math.max(0, enBase - (pieces.attendues - pieces.absentes.total));

  if (pieces.absentes.total > 0) {
    anomalies.push(
      `${pieces.absentes.total} enregistrement(s) de l’inventaire absent(s) de la base restaurée.`,
    );
  }
  if (pieces.divergentes.total > 0) {
    anomalies.push(
      `${pieces.divergentes.total} enregistrement(s) dont la base ne dit plus la même chose que la prise.`,
    );
  }
  if (pieces.enTrop > 0) {
    // Une base qui contient plus que la prise n'est pas celle qu'on croit
    // restaurer : dump plus ancien que la base, ou mauvaise cible.
    anomalies.push(
      `${pieces.enTrop} enregistrement(s) en base qu’aucune ligne de l’inventaire ne décrit.`,
    );
  }

  return {
    cible: cibleLisible(options.cible),
    migration,
    locataires: {
      attendus: manifeste.locataires.length,
      trouves: locataires.length,
      divergents,
    },
    pieces,
    anomalies,
    fidele: anomalies.length === 0,
  };
}

function etatDeMigration(
  migrations: { derniere: string | null; total: number },
  manifeste: Manifeste,
): EtatMigration {
  const attendue = manifeste.base.derniereMigration;
  const attendues = manifeste.base.migrationsAppliquees;
  if (migrations.derniere === attendue && migrations.total === attendues) return 'conforme';
  if (migrations.total < attendues) return 'base en retard';
  if (migrations.total > attendues) return 'base plus avancée';
  return 'autre lignée';
}
