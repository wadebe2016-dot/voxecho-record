import type { IngestDirection, IngestOperationCategory } from '../ingestion/contract.js';
import type { PolicyDecision, RecordingPolicy, PolicyRule } from './contract.js';

/**
 * Moteur de décision d'enregistrement — CLAUDE.md §9.23.
 *
 * Rend toujours une décision **motivée** : non pas « cet appel n'est pas
 * enregistré », mais « cet appel n'est pas enregistré parce que la règle
 * "Médecine du travail" l'exclut, sous la version 7 de la politique ». Sans
 * cela, un appel manquant serait indistinguable d'un appel perdu — et c'est
 * exactement la question que posera un contrôleur le jour où l'on cessera
 * d'enregistrer systématiquement.
 */

/** Ce que le connecteur sait de l'appel au moment de décider. */
export interface AppelACapturer {
  /** Identifiant d'appel du PBX : c'est lui qui rend le tirage rejouable. */
  refci: string;
  /** Poste enregistré. */
  near: string;
  /** Correspondant. */
  far: string;
  direction: IngestDirection;
  category?: IngestOperationCategory;
}

export interface DecisionEnregistrement {
  /** L'appel doit-il être capté ? */
  enregistrer: boolean;
  /** Ce qui a tranché, tel qu'il sera écrit au journal et à l'écran. */
  motif: string;
  /** Nature de la décision retenue, avant application du tirage. */
  decision: PolicyDecision;
  /** Origine : une exclusion, une règle nommée, ou le défaut de la politique. */
  origine: 'exclusion' | 'regle' | 'defaut';
  /** Libellé de la règle qui a tranché, s'il y en a une. */
  regle?: string;
  /** Renseignés quand un échantillonnage a tranché — le tirage se rejoue. */
  tauxPourcent?: number;
  tirage?: number;
  /** L'appelant doit-il être averti ? */
  annonce: boolean;
  /** L'agent peut-il suspendre l'enregistrement (saisie sensible) ? */
  pauseAutorisee: boolean;
}

/** `699*` correspond à tout numéro qui commence par 699 ; sinon égalité stricte. */
function correspond(motif: string, valeur: string): boolean {
  if (motif.endsWith('*')) return valeur.startsWith(motif.slice(0, -1));
  return motif === valeur;
}

/** Un motif s'applique-t-il à l'un des deux numéros de l'appel ? */
function touche(motif: string, appel: AppelACapturer): boolean {
  return correspond(motif, appel.near) || correspond(motif, appel.far);
}

/**
 * Tirage d'échantillonnage — déterministe, et c'est tout l'intérêt.
 *
 * Un tirage aléatoire serait indéfendable : « pourquoi cet appel-là n'a-t-il
 * pas été enregistré ? » n'aurait pour réponse que « le hasard ». Ici, la même
 * référence d'appel et la même règle donnent toujours le même nombre, qu'un
 * contrôleur peut recalculer des mois plus tard.
 *
 * **FNV-1a 32 bits, et non SHA-256.** Trois raisons, dans cet ordre : le
 * moteur doit tourner dans le navigateur, où `node:crypto` n'existe pas ; il
 * devra être réimplémenté dans le connecteur, en Lua ou en shell, où dix
 * lignes valent mieux qu'une dépendance ; et un contrôleur doit pouvoir
 * refaire le calcul. La résistance cryptographique n'est pas la propriété
 * recherchée — un agent ne choisit pas la référence d'appel, que le PBX
 * attribue — c'est la reproductibilité.
 *
 * Rend un entier de 0 à 99. L'appel est retenu si ce nombre est **strictement
 * inférieur** au taux : à 20 %, les tirages 0 à 19 sont enregistrés.
 */
export function tirageEchantillon(refci: string, cleRegle: string): number {
  const graine = `${refci}|${cleRegle}`;
  let empreinte = 0x811c9dc5;
  for (let index = 0; index < graine.length; index += 1) {
    empreinte ^= graine.charCodeAt(index) & 0xff;
    // Multiplication par le nombre premier FNV, en arithmétique 32 bits non
    // signée : `Math.imul` évite la perte de précision des flottants.
    empreinte = Math.imul(empreinte, 0x01000193) >>> 0;
  }
  return empreinte % 100;
}

function critereCorrespond(
  regle: PolicyRule,
  appel: AppelACapturer,
  politique: RecordingPolicy,
): boolean {
  switch (regle.critere) {
    case 'near':
      return correspond(regle.valeur, appel.near);
    case 'far':
      return correspond(regle.valeur, appel.far);
    case 'direction':
      return regle.valeur === appel.direction;
    case 'category':
      // Une catégorie absente n'est pas « autre » ici : le producteur ne l'a
      // pas déclarée, et une règle sur `autre` ne doit pas attraper ce qu'on
      // n'a pas classé. C'est l'ingestion qui range en « autre » (§9.10).
      return appel.category !== undefined && regle.valeur === appel.category;
    case 'liste': {
      const liste = politique.listes.find((candidate) => candidate.nom === regle.valeur);
      return liste !== undefined && liste.numeros.some((motif) => touche(motif, appel));
    }
    default:
      return false;
  }
}

/**
 * Décide du sort d'un appel.
 *
 * Ordre d'évaluation, et il n'est pas négociable :
 * 1. les **exclusions**, qui priment sur tout ;
 * 2. les **règles**, dans l'ordre, la première qui correspond ;
 * 3. le **défaut** de la politique.
 */
export function deciderEnregistrement(
  politique: RecordingPolicy,
  appel: AppelACapturer,
): DecisionEnregistrement {
  const exclusion = politique.exclusions.find((motif) => touche(motif, appel));
  if (exclusion !== undefined) {
    return {
      enregistrer: false,
      decision: 'never',
      origine: 'exclusion',
      motif:
        `Exclusion « ${exclusion} »` +
        (politique.motifExclusions ? ` — ${politique.motifExclusions}` : ''),
      annonce: false,
      pauseAutorisee: false,
    };
  }

  for (const regle of politique.regles) {
    if (!critereCorrespond(regle, appel, politique)) continue;
    return appliquer(regle.decision, appel, {
      origine: 'regle',
      regle: regle.libelle,
      motif: `Règle « ${regle.libelle} »`,
      cleTirage: regle.libelle,
      tauxPourcent: regle.tauxPourcent,
      annonce: regle.annonce,
      pauseAutorisee: regle.pauseAutorisee,
    });
  }

  return appliquer(politique.parDefaut, appel, {
    origine: 'defaut',
    motif: 'Politique par défaut',
    cleTirage: 'defaut',
    tauxPourcent: politique.tauxParDefautPourcent,
    annonce: false,
    pauseAutorisee: false,
  });
}

interface Contexte {
  origine: DecisionEnregistrement['origine'];
  regle?: string;
  motif: string;
  cleTirage: string;
  tauxPourcent?: number;
  annonce: boolean;
  pauseAutorisee: boolean;
}

function appliquer(
  decision: PolicyDecision,
  appel: AppelACapturer,
  contexte: Contexte,
): DecisionEnregistrement {
  const commun = {
    decision,
    origine: contexte.origine,
    ...(contexte.regle !== undefined ? { regle: contexte.regle } : {}),
    annonce: contexte.annonce,
    pauseAutorisee: contexte.pauseAutorisee,
  };

  if (decision === 'sample') {
    const taux = contexte.tauxPourcent ?? 0;
    const tirage = tirageEchantillon(appel.refci, contexte.cleTirage);
    const retenu = tirage < taux;
    return {
      ...commun,
      enregistrer: retenu,
      tauxPourcent: taux,
      tirage,
      motif: `${contexte.motif} — échantillon ${taux} %, tirage ${tirage} : ${retenu ? 'retenu' : 'écarté'}`,
    };
  }

  if (decision === 'on_demand') {
    // Non enregistré d'office : c'est l'agent qui déclenchera, et le
    // connecteur qui l'exécutera. Côté Record, un appel qu'on n'a pas reçu
    // reste un appel non enregistré, motivé comme tel.
    return { ...commun, enregistrer: false, motif: `${contexte.motif} — à la demande de l’agent` };
  }

  return {
    ...commun,
    enregistrer: decision === 'always',
    motif: `${contexte.motif} — ${decision === 'always' ? 'enregistrement systématique' : 'jamais enregistré'}`,
  };
}
