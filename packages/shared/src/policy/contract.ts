import { z } from 'zod';
import { INGEST_DIRECTIONS, INGEST_OPERATION_CATEGORIES } from '../ingestion/contract.js';

/**
 * Politique d'enregistrement sélectif — CLAUDE.md §9.23.
 *
 * Jusqu'ici le produit enregistrait tout ce que la capture lui déposait. Une
 * politique dit **ce qu'il faut enregistrer**, et donc ce qu'on renonce à
 * enregistrer : c'est un renversement pour un produit de preuve, et tout ce
 * contrat est écrit pour que ce renoncement reste défendable devant un
 * contrôleur.
 *
 * Trois exigences en découlent, qui expliquent chaque choix ci-dessous :
 *
 * - **une décision se motive** : le moteur ne rend jamais un simple oui/non,
 *   il rend la règle qui a tranché ;
 * - **une décision se rejoue** : l'échantillonnage est déterministe, pas
 *   aléatoire, faute de quoi « pourquoi cet appel n'a-t-il pas été enregistré ? »
 *   n'aurait aucune réponse ;
 * - **une décision se date** : la politique est versionnée, et la version
 *   voyage avec la décision.
 *
 * Le moteur vit ici, dans le paquet partagé, et non dans l'api : c'est le
 * connecteur qui l'exécutera au moment de l'appel, et le portail qui le
 * rejouera pour montrer ce qui se passerait. Une seule implémentation, sans
 * quoi l'écran promettrait une chose et la téléphonie en ferait une autre.
 */

/** Version du contrat de politique, indépendante du contrat d'ingestion. */
export const POLICY_SCHEMA_VERSION = 1;

/**
 * Ce qu'une règle décide.
 *
 * `on_demand` — l'appel n'est pas enregistré d'office ; l'agent le déclenche
 * pendant la conversation. C'est au connecteur de l'exécuter : côté Record, un
 * appel `on_demand` non déclenché est un appel non enregistré comme un autre,
 * et il se trace comme tel.
 */
export const POLICY_DECISIONS = ['always', 'never', 'sample', 'on_demand'] as const;
export type PolicyDecision = (typeof POLICY_DECISIONS)[number];

/** Ce sur quoi une règle peut porter. */
export const POLICY_CRITERIA = ['near', 'far', 'liste', 'direction', 'category'] as const;
export type PolicyCriterion = (typeof POLICY_CRITERIA)[number];

/**
 * Motif d'un numéro : chiffres, `+`, et `*` en fin comme joker de préfixe.
 * Volontairement pauvre — un administrateur écrit `699*`, pas une expression
 * régulière dont personne ne saura dire ce qu'elle attrape.
 */
export const POLICY_NUMBER_PATTERN = /^[0-9+][0-9+.-]{0,30}\*?$/;

const motifNumero = z
  .string()
  .min(1)
  .max(32)
  .regex(POLICY_NUMBER_PATTERN, 'numéro ou préfixe attendu, par exemple 1001 ou 699*');

const nomListe = z
  .string()
  .min(1)
  .max(60)
  .regex(/^[\p{L}\p{N} '’.-]+$/u, 'nom de liste : lettres, chiffres, espaces et tirets');

/**
 * Liste nommée de postes ou de numéros — « Service RH », « Salle des marchés ».
 *
 * Tient lieu de « département » et de « groupe » tant qu'aucun annuaire n'est
 * branché : elle rend le même service sans inventer une hiérarchie que
 * personne n'alimenterait.
 */
export const policyListSchema = z.object({
  nom: nomListe,
  numeros: z.array(motifNumero).min(1).max(500),
});
export type PolicyList = z.infer<typeof policyListSchema>;

export const policyRuleSchema = z.object({
  /** Libellé lisible : c'est lui qui apparaîtra au journal et à l'écran. */
  libelle: z.string().min(3).max(120),
  critere: z.enum(POLICY_CRITERIA),
  /**
   * Valeur comparée, selon le critère : un motif de numéro, un nom de liste,
   * un sens d'appel ou une catégorie d'opération.
   */
  valeur: z.string().min(1).max(64),
  decision: z.enum(POLICY_DECISIONS),
  /** Taux d'échantillonnage, de 1 à 99. Exigé si et seulement si `sample`. */
  tauxPourcent: z.number().int().min(1).max(99).optional(),
  /** L'appelant est averti que la conversation est enregistrée. */
  annonce: z.boolean().default(false),
  /**
   * L'agent peut suspendre l'enregistrement le temps d'une saisie sensible —
   * un numéro de carte, par exemple. Déclaré ici, exécuté par le connecteur.
   */
  pauseAutorisee: z.boolean().default(false),
});
export type PolicyRule = z.infer<typeof policyRuleSchema>;

export const recordingPolicySchema = z
  .object({
    schema: z.literal(POLICY_SCHEMA_VERSION),
    /**
     * Ce qui s'applique quand aucune règle ne correspond. `always` est le
     * défaut du produit : ne pas enregistrer doit toujours résulter d'une
     * décision écrite, jamais d'un oubli de règle.
     */
    parDefaut: z.enum(POLICY_DECISIONS).default('always'),
    tauxParDefautPourcent: z.number().int().min(1).max(99).optional(),
    /**
     * Numéros jamais enregistrés, quoi que disent les règles. Séparés d'elles
     * et évalués en premier : si c'étaient des règles ordonnées, un
     * administrateur qui réordonne sa liste exposerait un jour la ligne de la
     * médecine du travail.
     */
    exclusions: z.array(motifNumero).max(500).default([]),
    /** Justification des exclusions, pour qu'un contrôleur sache d'où elles viennent. */
    motifExclusions: z.string().max(500).default(''),
    listes: z.array(policyListSchema).max(50).default([]),
    regles: z.array(policyRuleSchema).max(100).default([]),
  })
  .superRefine((politique, contexte) => {
    if (politique.parDefaut === 'sample' && politique.tauxParDefautPourcent === undefined) {
      contexte.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['tauxParDefautPourcent'],
        message: 'un échantillonnage sans taux n’est pas une politique',
      });
    }
    const connues = new Set(politique.listes.map((liste) => liste.nom));
    politique.regles.forEach((regle, index) => {
      if (regle.decision === 'sample' && regle.tauxPourcent === undefined) {
        contexte.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['regles', index, 'tauxPourcent'],
          message: 'un échantillonnage sans taux n’est pas une politique',
        });
      }
      if (regle.decision !== 'sample' && regle.tauxPourcent !== undefined) {
        // Un taux sur une règle qui n'échantillonne pas laisse croire à un
        // effet qu'il n'a pas : on le refuse au lieu de l'ignorer.
        contexte.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['regles', index, 'tauxPourcent'],
          message: 'un taux ne se lit que sur une règle d’échantillonnage',
        });
      }
      if (regle.critere === 'liste' && !connues.has(regle.valeur)) {
        contexte.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['regles', index, 'valeur'],
          message: `aucune liste nommée « ${regle.valeur} »`,
        });
      }
      if (regle.critere === 'direction' && !INGEST_DIRECTIONS.includes(regle.valeur as never)) {
        contexte.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['regles', index, 'valeur'],
          message: `sens inconnu : ${INGEST_DIRECTIONS.join(', ')} attendus`,
        });
      }
      if (
        regle.critere === 'category' &&
        !INGEST_OPERATION_CATEGORIES.includes(regle.valeur as never)
      ) {
        contexte.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['regles', index, 'valeur'],
          message: `catégorie inconnue : ${INGEST_OPERATION_CATEGORIES.join(', ')} attendues`,
        });
      }
      if (
        (regle.critere === 'near' || regle.critere === 'far') &&
        !POLICY_NUMBER_PATTERN.test(regle.valeur)
      ) {
        contexte.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['regles', index, 'valeur'],
          message: 'numéro ou préfixe attendu, par exemple 1001 ou 699*',
        });
      }
    });
  });

export type RecordingPolicy = z.infer<typeof recordingPolicySchema>;

export type PolicyParseResult =
  { ok: true; value: RecordingPolicy } | { ok: false; errors: string[] };

export function parseRecordingPolicy(input: unknown): PolicyParseResult {
  const resultat = recordingPolicySchema.safeParse(input);
  if (resultat.success) return { ok: true, value: resultat.data };
  return {
    ok: false,
    errors: resultat.error.issues.map((issue) => {
      const chemin = issue.path.join('.');
      return chemin ? `${chemin}: ${issue.message}` : issue.message;
    }),
  };
}

/** Politique la plus simple qui soit : tout est enregistré, rien n'est exclu. */
export function politiqueParDefaut(): RecordingPolicy {
  return {
    schema: POLICY_SCHEMA_VERSION,
    parDefaut: 'always',
    exclusions: [],
    motifExclusions: '',
    listes: [],
    regles: [],
  };
}
