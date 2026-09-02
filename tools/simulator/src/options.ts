import { isTenantSlug } from '@voxecho/shared';

/**
 * Analyse de la ligne de commande — CLAUDE.md §4.
 *
 * Fonction pure : elle ne lit ni l'environnement ni le disque, et ne lève
 * jamais. Les erreurs remontent au CLI qui décide de l'affichage et du code
 * de sortie.
 */

export type Mode = 'one' | 'batch' | 'continuous';

export interface Options {
  mode: Mode;
  /** Nombre d'appels pour `--batch`. */
  count: number;
  /** Appels par minute pour `--continuous`. */
  rate: number;
  /** Locataires visés : le dépôt va dans `INGEST_DIR/<slug>/`. */
  tenants: string[];
  ingestDir: string;
  /** Dépose des fichiers volontairement avariés (§4). */
  corrupt: boolean;
  /** Graine du tirage : à graine égale, dépôts identiques. */
  seed: number;
  /** Répartit les appels sur les N derniers jours plutôt que sur aujourd'hui. */
  spreadDays: number;
}

export type ResultatOptions = { ok: true; value: Options } | { ok: false; errors: string[] };

export const DEFAUTS = {
  ingestDir: './data/ingest',
  tenant: 'banque-cemac',
  count: 50,
  rate: 10,
  spreadDays: 1,
} as const;

export const AIDE = `Simulateur VoxEcho — dépose des appels au contrat §3, sans téléphonie.

  --one                 dépose un appel et rend la main
  --batch <n>           dépose n appels (défaut ${DEFAUTS.count})
  --continuous <n>/min  dépose en continu, n appels par minute, jusqu'à Ctrl+C
  --corrupt             abîme les dépôts (json malformé, wav tronqué) :
                        ils doivent finir en quarantaine
  --tenant <slug[,...]> locataires visés (défaut « ${DEFAUTS.tenant} »)
  --dir <chemin>        répertoire d'ingestion (défaut INGEST_DIR ou ${DEFAUTS.ingestDir})
  --spread-days <n>     répartit les appels sur les n derniers jours (défaut ${DEFAUTS.spreadDays})
  --seed <n>            graine du tirage, pour rejouer une démonstration
  --help                affiche cette aide

Exemples :
  pnpm --filter @voxecho/simulator simulate -- --batch 50
  pnpm --filter @voxecho/simulator simulate -- --continuous 10/min --tenant banque-cemac,mfi-b
  pnpm --filter @voxecho/simulator simulate -- --one --corrupt`;

/** `10/min`, `10/mn` ou `10` : le débit s'écrit comme on le dit. */
export function parseRate(brut: string): number | null {
  const match = /^(\d+)(?:\s*\/\s*(min|mn|minute))?$/i.exec(brut.trim());
  if (!match) return null;
  const valeur = Number(match[1]);
  return valeur > 0 ? valeur : null;
}

export function parseOptions(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = {},
): ResultatOptions {
  const errors: string[] = [];
  const options: Options = {
    mode: 'one',
    count: DEFAUTS.count,
    rate: DEFAUTS.rate,
    tenants: [DEFAUTS.tenant],
    ingestDir: env.INGEST_DIR ?? DEFAUTS.ingestDir,
    corrupt: false,
    seed: Date.now() >>> 0,
    spreadDays: DEFAUTS.spreadDays,
  };

  let modeDonne = false;
  const valeurSuivante = (index: number, drapeau: string): string | null => {
    const valeur = argv[index + 1];
    if (valeur === undefined || valeur.startsWith('--')) {
      errors.push(`${drapeau} attend une valeur`);
      return null;
    }
    return valeur;
  };

  for (let index = 0; index < argv.length; index += 1) {
    const drapeau = argv[index] as string;
    switch (drapeau) {
      case '--one':
        options.mode = 'one';
        modeDonne = true;
        break;

      case '--batch': {
        const valeur = valeurSuivante(index, '--batch');
        if (valeur !== null) {
          const nombre = Number(valeur);
          if (!Number.isInteger(nombre) || nombre < 1) {
            errors.push(`--batch attend un entier positif, reçu « ${valeur} »`);
          } else {
            options.count = nombre;
            options.mode = 'batch';
            modeDonne = true;
          }
          index += 1;
        }
        break;
      }

      case '--continuous': {
        const valeur = valeurSuivante(index, '--continuous');
        if (valeur !== null) {
          const rate = parseRate(valeur);
          if (rate === null) {
            errors.push(`--continuous attend un débit, ex. « 10/min », reçu « ${valeur} »`);
          } else {
            options.rate = rate;
            options.mode = 'continuous';
            modeDonne = true;
          }
          index += 1;
        }
        break;
      }

      case '--corrupt':
        options.corrupt = true;
        break;

      case '--tenant': {
        const valeur = valeurSuivante(index, '--tenant');
        if (valeur !== null) {
          const slugs = valeur
            .split(',')
            .map((slug) => slug.trim())
            .filter((slug) => slug.length > 0);
          const invalides = slugs.filter((slug) => !isTenantSlug(slug));
          if (slugs.length === 0) {
            errors.push('--tenant attend au moins un slug');
          } else if (invalides.length > 0) {
            errors.push(
              `slug de locataire invalide : ${invalides.join(', ')} (minuscules, chiffres et tirets)`,
            );
          } else {
            options.tenants = slugs;
          }
          index += 1;
        }
        break;
      }

      case '--dir': {
        const valeur = valeurSuivante(index, '--dir');
        if (valeur !== null) {
          options.ingestDir = valeur;
          index += 1;
        }
        break;
      }

      case '--spread-days': {
        const valeur = valeurSuivante(index, '--spread-days');
        if (valeur !== null) {
          const nombre = Number(valeur);
          if (!Number.isInteger(nombre) || nombre < 1) {
            errors.push(`--spread-days attend un entier positif, reçu « ${valeur} »`);
          } else {
            options.spreadDays = nombre;
          }
          index += 1;
        }
        break;
      }

      case '--seed': {
        const valeur = valeurSuivante(index, '--seed');
        if (valeur !== null) {
          const nombre = Number(valeur);
          if (!Number.isInteger(nombre) || nombre < 0) {
            errors.push(`--seed attend un entier positif ou nul, reçu « ${valeur} »`);
          } else {
            options.seed = nombre >>> 0;
          }
          index += 1;
        }
        break;
      }

      default:
        errors.push(
          drapeau.startsWith('--')
            ? `option inconnue : ${drapeau}`
            : `valeur isolée sans option : « ${drapeau} »`,
        );
    }
  }

  // `--corrupt` seul est un mode à part entière au §4 : il abîme un dépôt.
  if (!modeDonne && options.corrupt) options.mode = 'one';

  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: options };
}
