import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { resoudreCheminDeDonnees } from '../config/chemins';
import { TAILLE_CLE } from '../storage/coffre';
import { analyserArguments } from './arguments';
import { verifierSauvegarde, type RapportSauvegarde } from './verification.service';

/**
 * Vérifie une sauvegarde — CLAUDE.md §9.14.
 *
 *   pnpm --filter @voxecho/api run sauvegarde:verifier [<répertoire>] \
 *     [--empreinte <sha256 du manifeste>] [--stockage]
 *
 * Sans répertoire, la dernière prise trouvée dans `BACKUP_DIR` est vérifiée.
 * `--stockage` confronte en plus l'inventaire au disque, en recalculant
 * l'empreinte de chaque pièce — c'est plus long, et c'est la seule
 * vérification qui prouve quelque chose sur les preuves elles-mêmes.
 *
 * Sortie non nulle dès qu'une anomalie est constatée : une vérification qui
 * réussit toujours ne vérifie rien.
 */

/** La dernière prise d'un répertoire de sauvegardes : les noms sont datés. */
async function dernierePrise(racine: string): Promise<string> {
  const entrees = await readdir(racine, { withFileTypes: true });
  const prises = entrees
    .filter((entree) => entree.isDirectory())
    .map((entree) => entree.name)
    .sort();
  const derniere = prises.at(-1);
  if (!derniere) throw new Error(`Aucune sauvegarde dans ${racine}.`);
  return join(racine, derniere);
}

function afficher(rapport: RapportSauvegarde): void {
  const { manifeste } = rapport;
  console.warn(`Sauvegarde ${rapport.repertoire}`);
  console.warn(`  prise le   : ${manifeste.produitLe} (version ${manifeste.version})`);
  console.warn(
    `  manifeste  : ${rapport.empreinteManifeste} — empreinte consignée : ${rapport.empreinteConsignee}`,
  );
  console.warn(
    `  base       : ${rapport.base.conforme ? 'conforme' : 'DIVERGENTE'}, ` +
      `${rapport.base.signature ? 'archive pg_dump reconnue' : 'SIGNATURE pg_dump ABSENTE'}, ` +
      `dernière migration « ${manifeste.base.derniereMigration ?? 'aucune'} »`,
  );
  console.warn(
    `  inventaire : ${rapport.inventaire.conforme ? 'conforme' : 'DIVERGENT'}, ` +
      `${rapport.inventaire.lignes} pièce(s)`,
  );
  console.warn(`  clé maître : ${rapport.cleMaitre}`);

  if (rapport.stockage) {
    const s = rapport.stockage;
    console.warn(
      `  stockage   : ${s.verifiees}/${s.attendues} pièce(s) vérifiée(s) par empreinte` +
        `${s.sceauxNonVerifies > 0 ? `, ${s.sceauxNonVerifies} scellée(s) non ouverte(s)` : ''}`,
    );
    const listes: [string, string[]][] = [
      ['manquante(s)', s.manquantes],
      ['divergente(s)', s.divergentes],
      ['clé inconnue', s.clesInconnues],
      ['déclaration absente', s.declarationsAbsentes],
      ['purgée(s) mais présente(s)', s.purgeesAvecFichier],
      ['orpheline(s)', s.orphelins],
    ];
    for (const [intitule, liste] of listes) {
      for (const element of liste) console.warn(`    ! ${intitule} : ${element}`);
    }
    if (s.tronque) console.warn('    … listes tronquées : relancer après correction.');
  } else {
    console.warn('  stockage   : non vérifié (relancer avec --stockage)');
  }

  console.warn('');
  if (rapport.restaurable) {
    console.warn('Aucune anomalie constatée.');
  } else {
    for (const anomalie of rapport.anomalies) console.warn(`! ${anomalie}`);
  }
}

async function main(): Promise<void> {
  const arguments_ = analyserArguments(process.argv.slice(2), ['--empreinte'], ['--stockage']);
  const racine = resoudreCheminDeDonnees(process.env.BACKUP_DIR ?? './data/backups');
  const positionnel = arguments_.positionnels[0];
  const repertoire = positionnel
    ? resoudreCheminDeDonnees(positionnel)
    : await dernierePrise(racine);

  const brut = process.env.STORAGE_MASTER_KEY ?? '';
  const cleMaitre = brut === '' ? null : Buffer.from(brut, 'base64');
  if (cleMaitre !== null && cleMaitre.length !== TAILLE_CLE) {
    throw new Error(
      `STORAGE_MASTER_KEY de mauvaise taille : ${TAILLE_CLE} octets en base64 attendus.`,
    );
  }

  const rapport = await verifierSauvegarde({
    repertoire,
    cleMaitre,
    empreinteAttendue: arguments_.valeurs.get('--empreinte') ?? null,
    storageDir: arguments_.drapeaux.has('--stockage')
      ? resoudreCheminDeDonnees(process.env.STORAGE_DIR ?? './data/storage')
      : null,
  });

  afficher(rapport);
  process.exitCode = rapport.restaurable ? 0 : 1;
}

void main().catch((erreur: unknown) => {
  console.error(erreur instanceof Error ? erreur.message : erreur);
  process.exitCode = 1;
});
