import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, readFile, readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { INGEST_METADATA_EXTENSION } from '@voxecho/shared';
import { empreinteCleMaitre, estConteneur, fluxDeClair, lireEntete } from '../storage/coffre';
import {
  empreinteDe,
  lireManifeste,
  NOM_DUMP,
  NOM_INVENTAIRE,
  NOM_MANIFESTE,
  type Manifeste,
} from './manifeste';
import { parcourirInventaire, type LigneInventaire } from './inventaire';
import { SIGNATURE_DUMP } from './pg-dump';

/**
 * Vérification d'une sauvegarde — CLAUDE.md §9.14.
 *
 * Une sauvegarde qu'on n'a jamais essayé de relire n'est pas une sauvegarde,
 * c'est une intention. Cette vérification va aussi loin qu'on peut aller sans
 * restaurer : les fichiers de la prise concordent-ils avec leur manifeste, la
 * clé maître dont on dispose est-elle bien celle qui a scellé les pièces, et
 * le stockage contient-il exactement ce que la base y attend.
 *
 * Elle dit toujours **jusqu'où elle est allée** : faute de clé, les sceaux ne
 * sont pas ouverts, et le rapport le déclare plutôt que de laisser croire à
 * une vérification complète.
 */

/** Au-delà, les listes d'anomalies sont comptées mais plus énumérées. */
const MAX_DETAIL = 20;

export interface RapportStockage {
  /** Pièces attendues sur le disque (les purgées ne le sont pas). */
  attendues: number;
  /** Pièces dont l'empreinte du clair a été recalculée et concorde. */
  verifiees: number;
  /** Pièces scellées constatées présentes, sceau non ouvert faute de clé. */
  sceauxNonVerifies: number;
  manquantes: string[];
  divergentes: string[];
  /** Pièces scellées avec une clé que le manifeste ne connaît pas. */
  clesInconnues: string[];
  /** Fichiers présents sur le disque qu'aucune ligne de base ne réclame. */
  orphelins: string[];
  /** Pièces dont la déclaration d'origine (le json du contrat §3) manque. */
  declarationsAbsentes: string[];
  /** Pièces purgées dont un fichier est pourtant revenu à sa place. */
  purgeesAvecFichier: string[];
  tronque: boolean;
}

export interface RapportSauvegarde {
  repertoire: string;
  manifeste: Manifeste;
  empreinteManifeste: string;
  empreinteConsignee: 'concorde' | 'diverge' | 'non fournie';
  base: { octets: number; sha256: string; conforme: boolean; signature: boolean };
  inventaire: { sha256: string; conforme: boolean; lignes: number };
  cleMaitre: 'concorde' | 'diverge' | 'absente' | 'sans objet';
  stockage: RapportStockage | null;
  anomalies: string[];
  /** Vrai si rien ne cloche : c'est le seul résultat qui autorise à dormir. */
  restaurable: boolean;
}

export interface OptionsVerification {
  repertoire: string;
  /** Clé maître dont dispose l'exploitant, à confronter au manifeste. */
  cleMaitre: Buffer | null;
  /** Empreinte du manifeste consignée ailleurs, si elle l'a été. */
  empreinteAttendue?: string | null;
  /** Racine du stockage à confronter à l'inventaire ; nulle pour s'en tenir
   *  à la prise elle-même. */
  storageDir?: string | null;
}

async function empreinteDuFichier(chemin: string): Promise<{ sha256: string; octets: number }> {
  const hachage = createHash('sha256');
  let octets = 0;
  for await (const morceau of createReadStream(chemin)) {
    const bloc = morceau as Buffer;
    octets += bloc.length;
    hachage.update(bloc);
  }
  return { sha256: hachage.digest('hex'), octets };
}

/**
 * Empreinte d'une pièce de la prise, ou son absence. Un fichier manquant est
 * une anomalie à consigner comme les autres : c'est même la première qu'une
 * sauvegarde amputée doit produire, et elle ne doit pas sortir en trace
 * d'exécution sous les yeux de qui vérifie.
 */
async function empreinteOuAbsence(
  chemin: string,
): Promise<{ sha256: string; octets: number; present: boolean }> {
  try {
    return { ...(await empreinteDuFichier(chemin)), present: true };
  } catch (erreur) {
    if ((erreur as NodeJS.ErrnoException).code !== 'ENOENT') throw erreur;
    return { sha256: '', octets: 0, present: false };
  }
}

async function commencePar(chemin: string, signature: Buffer): Promise<boolean> {
  const fichier = await open(chemin, 'r');
  try {
    const tampon = Buffer.alloc(signature.length);
    const { bytesRead } = await fichier.read(tampon, 0, signature.length, 0);
    return bytesRead === signature.length && tampon.equals(signature);
  } finally {
    await fichier.close();
  }
}

/** Tous les fichiers d'une arborescence, en chemins relatifs à sa racine. */
async function fichiersDe(racine: string): Promise<Set<string>> {
  const trouves = new Set<string>();
  async function descendre(repertoire: string): Promise<void> {
    let entrees;
    try {
      entrees = await readdir(repertoire, { withFileTypes: true });
    } catch {
      return; // Racine absente : le rapport le dira par les pièces manquantes.
    }
    for (const entree of entrees) {
      const chemin = join(repertoire, entree.name);
      if (entree.isDirectory()) await descendre(chemin);
      else trouves.add(relative(racine, chemin).split(sep).join('/'));
    }
  }
  await descendre(racine);
  return trouves;
}

/**
 * Empreinte du clair d'une pièce rangée. Une pièce scellée est ouverte en
 * flux, trame par trame : vérifier un stockage entier ne doit pas demander
 * de charger un appel de dix minutes en mémoire.
 */
async function empreinteDuClair(
  chemin: string,
  ligne: LigneInventaire,
  cleMaitre: Buffer | null,
): Promise<{ sha256: string; octets: number } | 'sceau-non-ouvert'> {
  const debut = Buffer.alloc(8);
  const fichier = await open(chemin, 'r');
  let scelle: boolean;
  let tailleClair = 0;
  try {
    await fichier.read(debut, 0, 8, 0);
    scelle = estConteneur(debut);
    if (scelle) {
      const tete = Buffer.alloc(40);
      await fichier.read(tete, 0, 40, 0);
      tailleClair = lireEntete(tete).tailleClair;
    }
  } finally {
    await fichier.close();
  }

  if (!scelle) return empreinteDuFichier(chemin);
  if (cleMaitre === null) {
    // Sans clé, on constate ce que le conteneur annonce, rien de plus : la
    // taille du clair est en clair dans l'en-tête, l'empreinte non.
    return tailleClair === ligne.octets ? 'sceau-non-ouvert' : { sha256: '', octets: tailleClair };
  }

  const hachage = createHash('sha256');
  let octets = 0;
  if (tailleClair > 0) {
    for await (const morceau of fluxDeClair(chemin, cleMaitre, ligne.id, 0, tailleClair - 1)) {
      const bloc = morceau as Buffer;
      octets += bloc.length;
      hachage.update(bloc);
    }
  }
  return { sha256: hachage.digest('hex'), octets };
}

async function verifierStockage(
  cheminInventaire: string,
  storageDir: string,
  manifeste: Manifeste,
  cleMaitre: Buffer | null,
): Promise<RapportStockage> {
  const rapport: RapportStockage = {
    attendues: 0,
    verifiees: 0,
    sceauxNonVerifies: 0,
    manquantes: [],
    divergentes: [],
    clesInconnues: [],
    orphelins: [],
    declarationsAbsentes: [],
    purgeesAvecFichier: [],
    tronque: false,
  };
  const surDisque = await fichiersDe(storageDir);
  const clesConnues = new Set(manifeste.stockage.cles);

  const ajouter = (liste: string[], valeur: string): void => {
    if (liste.length < MAX_DETAIL) liste.push(valeur);
    else rapport.tronque = true;
  };

  for await (const ligne of parcourirInventaire(cheminInventaire)) {
    const chemin = join(storageDir, ligne.chemin);
    const present = surDisque.delete(ligne.chemin);

    // L'ingestion range la déclaration du producteur à côté de la preuve
    // qu'elle décrit (contrat §3) : elle appartient au stockage, elle n'y est
    // pas orpheline. La purge, elle, ne détruit que la conversation — le json
    // d'une pièce purgée peut donc rester sans que rien ne cloche.
    const declaration = ligne.chemin.replace(/\.wav$/i, INGEST_METADATA_EXTENSION);
    const declarationPresente = surDisque.delete(declaration);

    if (ligne.statut === 'purged') {
      // Un fichier revenu à la place d'une pièce détruite n'est pas une bonne
      // nouvelle : la purge est un acte tracé, et rien ne doit la défaire.
      if (present) ajouter(rapport.purgeesAvecFichier, ligne.chemin);
      continue;
    }

    rapport.attendues += 1;
    if (!declarationPresente) ajouter(rapport.declarationsAbsentes, declaration);
    if (!present) {
      ajouter(rapport.manquantes, ligne.chemin);
      continue;
    }
    if (ligne.scellee && ligne.cle && !clesConnues.has(ligne.cle)) {
      ajouter(rapport.clesInconnues, `${ligne.chemin} (clé « ${ligne.cle} »)`);
    }

    try {
      const clair = await empreinteDuClair(chemin, ligne, cleMaitre);
      if (clair === 'sceau-non-ouvert') {
        rapport.sceauxNonVerifies += 1;
      } else if (clair.sha256 === ligne.sha256 && clair.octets === ligne.octets) {
        rapport.verifiees += 1;
      } else {
        ajouter(rapport.divergentes, ligne.chemin);
      }
    } catch (erreur) {
      // Un sceau qui ne s'ouvre pas est une divergence, pas une panne : c'est
      // exactement ce que le chiffrement était chargé de faire savoir.
      ajouter(
        rapport.divergentes,
        `${ligne.chemin} (${erreur instanceof Error ? erreur.message : String(erreur)})`,
      );
    }
  }

  for (const reste of surDisque) ajouter(rapport.orphelins, reste);
  return rapport;
}

export async function verifierSauvegarde(options: OptionsVerification): Promise<RapportSauvegarde> {
  const cheminManifeste = join(options.repertoire, NOM_MANIFESTE);
  const brut = await readFile(cheminManifeste, 'utf8');
  const manifeste = lireManifeste(brut);
  const empreinteManifeste = empreinteDe(brut);
  const anomalies: string[] = [];

  let empreinteConsignee: RapportSauvegarde['empreinteConsignee'] = 'non fournie';
  if (options.empreinteAttendue) {
    empreinteConsignee =
      options.empreinteAttendue.toLowerCase() === empreinteManifeste ? 'concorde' : 'diverge';
    if (empreinteConsignee === 'diverge') {
      anomalies.push(
        `Le manifeste ne correspond pas à l’empreinte consignée (${options.empreinteAttendue}) : la sauvegarde a été modifiée depuis sa prise.`,
      );
    }
  }

  const cheminDump = join(options.repertoire, manifeste.base.fichier || NOM_DUMP);
  const dump = await empreinteOuAbsence(cheminDump);
  const signature = dump.present && (await commencePar(cheminDump, SIGNATURE_DUMP));
  const baseConforme =
    dump.present && dump.sha256 === manifeste.base.sha256 && dump.octets === manifeste.base.octets;
  if (!dump.present) {
    anomalies.push(`Le dump de la base manque à la sauvegarde (${manifeste.base.fichier}).`);
  } else if (!baseConforme) {
    anomalies.push(
      `Le dump de la base ne correspond plus au manifeste (${dump.octets} octets, empreinte ${dump.sha256.slice(0, 16)}…).`,
    );
  }
  if (dump.present && !signature) {
    anomalies.push(
      'Le dump ne porte pas la signature d’une archive pg_dump : il est tronqué ou n’a pas été produit par pg_dump.',
    );
  }

  const cheminInventaire = join(options.repertoire, manifeste.stockage.fichier || NOM_INVENTAIRE);
  const inventaire = await empreinteOuAbsence(cheminInventaire);
  const inventaireConforme = inventaire.present && inventaire.sha256 === manifeste.stockage.sha256;
  if (!inventaire.present) {
    anomalies.push(
      `L’inventaire du stockage manque à la sauvegarde (${manifeste.stockage.fichier}).`,
    );
  } else if (!inventaireConforme) {
    anomalies.push('L’inventaire du stockage ne correspond plus au manifeste.');
  }

  let cleMaitre: RapportSauvegarde['cleMaitre'];
  if (manifeste.cleMaitre.empreinte === null) {
    cleMaitre = 'sans objet';
    if (manifeste.stockage.scellees > 0) {
      anomalies.push(
        `${manifeste.stockage.scellees} pièce(s) scellée(s) alors que la prise n’a retenu aucune empreinte de clé : la clé maître n’était pas configurée au moment de la sauvegarde.`,
      );
    }
  } else if (options.cleMaitre === null) {
    cleMaitre = 'absente';
    anomalies.push(
      'Aucune clé maître fournie : impossible de vérifier que la clé conservée est bien celle qui a scellé ces pièces (STORAGE_MASTER_KEY).',
    );
  } else if (empreinteCleMaitre(options.cleMaitre) === manifeste.cleMaitre.empreinte) {
    cleMaitre = 'concorde';
  } else {
    cleMaitre = 'diverge';
    anomalies.push(
      `La clé maître fournie n’est pas celle de cette sauvegarde (attendue ${manifeste.cleMaitre.empreinte}, fournie ${empreinteCleMaitre(options.cleMaitre)}) : les pièces scellées resteraient illisibles.`,
    );
  }

  let stockage: RapportStockage | null = null;
  // Sans inventaire, il n'y a rien à confronter au disque : on ne va pas
  // conclure sur un stockage à partir d'une liste qu'on n'a pas.
  if (options.storageDir && inventaire.present) {
    stockage = await verifierStockage(
      cheminInventaire,
      options.storageDir,
      manifeste,
      cleMaitre === 'concorde' ? options.cleMaitre : null,
    );
    if (stockage.manquantes.length > 0) {
      anomalies.push(`${stockage.manquantes.length} pièce(s) absente(s) du stockage.`);
    }
    if (stockage.divergentes.length > 0) {
      anomalies.push(
        `${stockage.divergentes.length} pièce(s) dont l’empreinte ne correspond plus à celle relevée à l’ingestion.`,
      );
    }
    if (stockage.clesInconnues.length > 0) {
      anomalies.push(
        `${stockage.clesInconnues.length} pièce(s) scellée(s) avec une clé absente du manifeste.`,
      );
    }
    if (stockage.purgeesAvecFichier.length > 0) {
      anomalies.push(
        `${stockage.purgeesAvecFichier.length} pièce(s) purgée(s) dont un fichier est pourtant présent.`,
      );
    }
    if (stockage.declarationsAbsentes.length > 0) {
      anomalies.push(
        `${stockage.declarationsAbsentes.length} pièce(s) dont la déclaration d’origine (json du contrat §3) manque au stockage.`,
      );
    }
    if (stockage.orphelins.length > 0) {
      anomalies.push(
        `${stockage.orphelins.length} fichier(s) du stockage qu’aucun enregistrement ne réclame.`,
      );
    }
    if (stockage.sceauxNonVerifies > 0) {
      anomalies.push(
        `${stockage.sceauxNonVerifies} pièce(s) scellée(s) constatée(s) présentes mais non ouvertes : sans la clé, leur intégrité n’est pas vérifiée.`,
      );
    }
  }

  const lignes = manifeste.stockage.pieces;
  return {
    repertoire: options.repertoire,
    manifeste,
    empreinteManifeste,
    empreinteConsignee,
    base: { octets: dump.octets, sha256: dump.sha256, conforme: baseConforme, signature },
    inventaire: { sha256: inventaire.sha256, conforme: inventaireConforme, lignes },
    cleMaitre,
    stockage,
    anomalies,
    restaurable: anomalies.length === 0,
  };
}
