import { useState } from 'react';
import {
  INGEST_DIRECTIONS,
  INGEST_OPERATION_CATEGORIES,
  POLICY_CRITERIA,
  POLICY_DECISIONS,
  type PolicyCriterion,
  type PolicyDecision,
  type PolicyRule,
  type RecordingPolicy,
} from '@voxecho/shared';

/**
 * Édition d'un brouillon de politique — CLAUDE.md §9.23.
 *
 * L'ordre des règles est visible et modifiable à la main : c'est la première
 * qui correspond qui décide, et un administrateur doit voir cet ordre plutôt
 * que de le deviner. Les exclusions sont ailleurs, dans leur propre bloc,
 * parce qu'elles priment sur tout — les mêler aux règles laisserait croire
 * qu'un déplacement pourrait les contourner.
 */

const CHAMP =
  'w-full rounded border border-ardoise-300 bg-white px-2 py-1 text-sm ' +
  'focus:border-ardoise-500 focus:outline-none focus:ring-1 focus:ring-ardoise-500';
const ETIQUETTE = 'mb-1 block text-xs font-medium text-ardoise-700';

const LIBELLE_DECISION: Record<PolicyDecision, string> = {
  always: 'Toujours enregistrer',
  never: 'Ne jamais enregistrer',
  sample: 'Échantillonner',
  on_demand: 'À la demande de l’agent',
};

const LIBELLE_CRITERE: Record<PolicyCriterion, string> = {
  near: 'Poste enregistré',
  far: 'Correspondant',
  liste: 'Liste nommée',
  direction: 'Sens de l’appel',
  category: 'Catégorie d’opération',
};

function regleVide(): PolicyRule {
  return {
    libelle: '',
    critere: 'near',
    valeur: '',
    decision: 'always',
    annonce: false,
    pauseAutorisee: false,
  };
}

/** Une zone de texte, un élément par ligne : lisible et copiable-collable. */
function lignes(valeur: string): string[] {
  return valeur
    .split('\n')
    .map((ligne) => ligne.trim())
    .filter((ligne) => ligne.length > 0);
}

export function EditeurPolitique({
  document,
  onChange,
}: {
  document: RecordingPolicy;
  onChange: (document: RecordingPolicy) => void;
}) {
  const [nouvelleListe, setNouvelleListe] = useState('');

  const modifier = (partie: Partial<RecordingPolicy>): void => onChange({ ...document, ...partie });

  const modifierRegle = (index: number, partie: Partial<PolicyRule>): void => {
    const regles = document.regles.map((regle, position) =>
      position === index ? { ...regle, ...partie } : regle,
    );
    modifier({ regles });
  };

  const deplacer = (index: number, sens: -1 | 1): void => {
    const cible = index + sens;
    if (cible < 0 || cible >= document.regles.length) return;
    const regles = [...document.regles];
    const [deplacee] = regles.splice(index, 1);
    regles.splice(cible, 0, deplacee as PolicyRule);
    modifier({ regles });
  };

  return (
    <div className="space-y-6">
      <section className="rounded border border-ardoise-200 bg-white p-4">
        <h3 className="mb-3 text-sm font-semibold">Par défaut</h3>
        <p className="mb-3 text-xs text-ardoise-600">
          Ce qui s’applique quand aucune règle ne correspond. Le défaut du produit enregistre
          tout&nbsp;: ne pas enregistrer doit résulter d’une décision, jamais d’un oubli de règle.
        </p>
        <div className="flex flex-wrap items-end gap-3">
          <div className="w-64">
            <label className={ETIQUETTE} htmlFor="parDefaut">
              Décision par défaut
            </label>
            <select
              id="parDefaut"
              className={CHAMP}
              value={document.parDefaut}
              onChange={(e) => modifier({ parDefaut: e.target.value as PolicyDecision })}
            >
              {POLICY_DECISIONS.map((decision) => (
                <option key={decision} value={decision}>
                  {LIBELLE_DECISION[decision]}
                </option>
              ))}
            </select>
          </div>
          {document.parDefaut === 'sample' && (
            <div className="w-32">
              <label className={ETIQUETTE} htmlFor="tauxDefaut">
                Taux (%)
              </label>
              <input
                id="tauxDefaut"
                type="number"
                min={1}
                max={99}
                className={CHAMP}
                value={document.tauxParDefautPourcent ?? ''}
                onChange={(e) =>
                  modifier({
                    tauxParDefautPourcent:
                      e.target.value === '' ? undefined : Number(e.target.value),
                  })
                }
              />
            </div>
          )}
        </div>
      </section>

      <section className="rounded border border-amber-300 bg-amber-50 p-4">
        <h3 className="mb-3 text-sm font-semibold">Jamais enregistrés</h3>
        <p className="mb-3 text-xs text-amber-900">
          Ces numéros priment sur toutes les règles, quel que soit leur ordre — ressources humaines,
          médecine du travail, représentation du personnel. Un numéro par ligne&nbsp;;
          <span className="font-mono"> 699*</span> vaut préfixe.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className={ETIQUETTE} htmlFor="exclusions">
              Numéros exclus
            </label>
            <textarea
              id="exclusions"
              rows={4}
              className={`${CHAMP} font-mono`}
              value={document.exclusions.join('\n')}
              onChange={(e) => modifier({ exclusions: lignes(e.target.value) })}
            />
          </div>
          <div>
            <label className={ETIQUETTE} htmlFor="motifExclusions">
              Motif des exclusions
            </label>
            <textarea
              id="motifExclusions"
              rows={4}
              className={CHAMP}
              placeholder="Ce qu’un contrôleur doit comprendre en lisant cette liste"
              value={document.motifExclusions}
              onChange={(e) => modifier({ motifExclusions: e.target.value })}
            />
          </div>
        </div>
      </section>

      <section className="rounded border border-ardoise-200 bg-white p-4">
        <h3 className="mb-3 text-sm font-semibold">Listes nommées</h3>
        <p className="mb-3 text-xs text-ardoise-600">
          Tiennent lieu de service ou de département tant qu’aucun annuaire n’est branché. Une règle
          peut ensuite porter sur une liste entière.
        </p>
        <div className="space-y-3">
          {document.listes.map((liste, index) => (
            <div key={liste.nom} className="rounded border border-ardoise-200 p-3">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-sm font-medium">{liste.nom}</span>
                <button
                  type="button"
                  className="text-xs text-red-700 hover:underline"
                  onClick={() =>
                    modifier({
                      listes: document.listes.filter((_, position) => position !== index),
                    })
                  }
                >
                  Retirer
                </button>
              </div>
              <textarea
                aria-label={`Numéros de ${liste.nom}`}
                rows={3}
                className={`${CHAMP} font-mono`}
                value={liste.numeros.join('\n')}
                onChange={(e) =>
                  modifier({
                    listes: document.listes.map((autre, position) =>
                      position === index ? { ...autre, numeros: lignes(e.target.value) } : autre,
                    ),
                  })
                }
              />
            </div>
          ))}
          <div className="flex gap-2">
            <input
              aria-label="Nom de la nouvelle liste"
              className={CHAMP}
              placeholder="Salle des marchés"
              value={nouvelleListe}
              onChange={(e) => setNouvelleListe(e.target.value)}
            />
            <button
              type="button"
              className="whitespace-nowrap rounded border border-ardoise-300 px-3 py-1 text-sm hover:bg-ardoise-50"
              onClick={() => {
                if (nouvelleListe.trim() === '') return;
                modifier({
                  listes: [...document.listes, { nom: nouvelleListe.trim(), numeros: [] }],
                });
                setNouvelleListe('');
              }}
            >
              Ajouter une liste
            </button>
          </div>
        </div>
      </section>

      <section className="rounded border border-ardoise-200 bg-white p-4">
        <h3 className="mb-1 text-sm font-semibold">Règles</h3>
        <p className="mb-3 text-xs text-ardoise-600">
          Évaluées dans cet ordre&nbsp;: <strong>la première qui correspond décide</strong>. Les
          exclusions ci-dessus passent avant toutes.
        </p>
        <ol className="space-y-3">
          {document.regles.map((regle, index) => (
            <li key={index} className="rounded border border-ardoise-200 p-3">
              <div className="mb-2 flex items-center gap-2">
                <span className="rounded bg-ardoise-100 px-2 py-0.5 text-xs tabular-nums">
                  {index + 1}
                </span>
                <input
                  aria-label={`Libellé de la règle ${index + 1}`}
                  className={CHAMP}
                  placeholder="Libellé lisible : c’est lui qui apparaîtra au journal"
                  value={regle.libelle}
                  onChange={(e) => modifierRegle(index, { libelle: e.target.value })}
                />
                <button
                  type="button"
                  aria-label={`Monter la règle ${index + 1}`}
                  className="rounded border border-ardoise-300 px-2 text-sm hover:bg-ardoise-50"
                  onClick={() => deplacer(index, -1)}
                >
                  ↑
                </button>
                <button
                  type="button"
                  aria-label={`Descendre la règle ${index + 1}`}
                  className="rounded border border-ardoise-300 px-2 text-sm hover:bg-ardoise-50"
                  onClick={() => deplacer(index, 1)}
                >
                  ↓
                </button>
                <button
                  type="button"
                  className="whitespace-nowrap text-xs text-red-700 hover:underline"
                  onClick={() =>
                    modifier({
                      regles: document.regles.filter((_, position) => position !== index),
                    })
                  }
                >
                  Retirer
                </button>
              </div>

              <div className="grid gap-3 sm:grid-cols-4">
                <div>
                  <label className={ETIQUETTE} htmlFor={`critere-${index}`}>
                    Critère
                  </label>
                  <select
                    id={`critere-${index}`}
                    className={CHAMP}
                    value={regle.critere}
                    onChange={(e) =>
                      modifierRegle(index, {
                        critere: e.target.value as PolicyCriterion,
                        valeur: '',
                      })
                    }
                  >
                    {POLICY_CRITERIA.map((critere) => (
                      <option key={critere} value={critere}>
                        {LIBELLE_CRITERE[critere]}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className={ETIQUETTE} htmlFor={`valeur-${index}`}>
                    Valeur
                  </label>
                  {regle.critere === 'direction' ||
                  regle.critere === 'category' ||
                  regle.critere === 'liste' ? (
                    <select
                      id={`valeur-${index}`}
                      className={CHAMP}
                      value={regle.valeur}
                      onChange={(e) => modifierRegle(index, { valeur: e.target.value })}
                    >
                      <option value="">—</option>
                      {(regle.critere === 'direction'
                        ? [...INGEST_DIRECTIONS]
                        : regle.critere === 'category'
                          ? [...INGEST_OPERATION_CATEGORIES]
                          : document.listes.map((liste) => liste.nom)
                      ).map((option) => (
                        <option key={option} value={option}>
                          {option}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      id={`valeur-${index}`}
                      className={`${CHAMP} font-mono`}
                      placeholder="1001 ou 699*"
                      value={regle.valeur}
                      onChange={(e) => modifierRegle(index, { valeur: e.target.value })}
                    />
                  )}
                </div>

                <div>
                  <label className={ETIQUETTE} htmlFor={`decision-${index}`}>
                    Décision
                  </label>
                  <select
                    id={`decision-${index}`}
                    className={CHAMP}
                    value={regle.decision}
                    onChange={(e) =>
                      modifierRegle(index, {
                        decision: e.target.value as PolicyDecision,
                        tauxPourcent:
                          e.target.value === 'sample' ? (regle.tauxPourcent ?? 20) : undefined,
                      })
                    }
                  >
                    {POLICY_DECISIONS.map((decision) => (
                      <option key={decision} value={decision}>
                        {LIBELLE_DECISION[decision]}
                      </option>
                    ))}
                  </select>
                </div>

                {regle.decision === 'sample' && (
                  <div>
                    <label className={ETIQUETTE} htmlFor={`taux-${index}`}>
                      Taux (%)
                    </label>
                    <input
                      id={`taux-${index}`}
                      type="number"
                      min={1}
                      max={99}
                      className={CHAMP}
                      value={regle.tauxPourcent ?? ''}
                      onChange={(e) =>
                        modifierRegle(index, {
                          tauxPourcent: e.target.value === '' ? undefined : Number(e.target.value),
                        })
                      }
                    />
                  </div>
                )}
              </div>

              <div className="mt-2 flex gap-4 text-xs">
                <label className="flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={regle.annonce}
                    onChange={(e) => modifierRegle(index, { annonce: e.target.checked })}
                  />
                  Annoncer l’enregistrement à l’appelant
                </label>
                <label className="flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={regle.pauseAutorisee}
                    onChange={(e) => modifierRegle(index, { pauseAutorisee: e.target.checked })}
                  />
                  Pause autorisée (saisie sensible)
                </label>
              </div>
            </li>
          ))}
        </ol>

        <button
          type="button"
          className="mt-3 rounded border border-ardoise-300 px-3 py-1 text-sm hover:bg-ardoise-50"
          onClick={() => modifier({ regles: [...document.regles, regleVide()] })}
        >
          Ajouter une règle
        </button>
      </section>
    </div>
  );
}
