import { useMemo, useState } from 'react';
import { Aide } from './Aide';
import {
  deciderEnregistrement,
  INGEST_DIRECTIONS,
  INGEST_OPERATION_CATEGORIES,
  type AppelACapturer,
  type IngestDirection,
  type IngestOperationCategory,
  type RecordingPolicy,
} from '@voxecho/shared';

/**
 * Simulateur de décision — CLAUDE.md §9.23.
 *
 * Rejoue le moteur partagé, celui qu'exécutera le connecteur : ce n'est pas
 * une approximation. Il éprouve le brouillon quand il y en a un, pour qu'on
 * voie ce qu'une politique changera avant de la rendre opposable.
 */

const CHAMP =
  'w-full rounded border border-ardoise-300 bg-white px-2 py-1 text-sm ' +
  'focus:border-ardoise-500 focus:outline-none focus:ring-1 focus:ring-ardoise-500';
const ETIQUETTE = 'mb-1 block text-xs font-medium text-ardoise-700';

export function SimulateurPolitique({
  document,
  source,
}: {
  document: RecordingPolicy;
  /** Ce qu'on éprouve : le brouillon en préparation ou la version publiée. */
  source: string;
}) {
  const [appel, setAppel] = useState<AppelACapturer>({
    refci: '16778001',
    near: '1001',
    far: '699112233',
    direction: 'outbound',
  });

  const decision = useMemo(() => deciderEnregistrement(document, appel), [document, appel]);
  const modifier = (partie: Partial<AppelACapturer>): void => setAppel({ ...appel, ...partie });

  return (
    <section
      className="rounded border border-ardoise-200 bg-white p-4"
      aria-labelledby="simulateur"
    >
      <h3 id="simulateur" className="mb-3 text-sm font-semibold">
        Simuler un appel <span className="font-normal text-ardoise-500">— sur {source}</span>
        <Aide texte="Le moteur utilisé ici est celui qu’exécutera la capture : le verdict est la décision réelle, rejouée." />
      </h3>

      <div className="grid gap-3 sm:grid-cols-5">
        <div>
          <label className={ETIQUETTE} htmlFor="sim-near">
            Poste
          </label>
          <input
            id="sim-near"
            className={`${CHAMP} font-mono`}
            value={appel.near}
            onChange={(e) => modifier({ near: e.target.value })}
          />
        </div>
        <div>
          <label className={ETIQUETTE} htmlFor="sim-far">
            Correspondant
          </label>
          <input
            id="sim-far"
            className={`${CHAMP} font-mono`}
            value={appel.far}
            onChange={(e) => modifier({ far: e.target.value })}
          />
        </div>
        <div>
          <label className={ETIQUETTE} htmlFor="sim-direction">
            Sens
          </label>
          <select
            id="sim-direction"
            className={CHAMP}
            value={appel.direction}
            onChange={(e) => modifier({ direction: e.target.value as IngestDirection })}
          >
            {INGEST_DIRECTIONS.map((sens) => (
              <option key={sens} value={sens}>
                {sens}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className={ETIQUETTE} htmlFor="sim-category">
            Catégorie
          </label>
          <select
            id="sim-category"
            className={CHAMP}
            value={appel.category ?? ''}
            onChange={(e) =>
              modifier({
                category:
                  e.target.value === '' ? undefined : (e.target.value as IngestOperationCategory),
              })
            }
          >
            <option value="">non déclarée</option>
            {INGEST_OPERATION_CATEGORIES.map((categorie) => (
              <option key={categorie} value={categorie}>
                {categorie}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className={ETIQUETTE} htmlFor="sim-refci">
            Référence d’appel
          </label>
          <input
            id="sim-refci"
            className={`${CHAMP} font-mono`}
            value={appel.refci}
            onChange={(e) => modifier({ refci: e.target.value })}
          />
        </div>
      </div>

      <div
        data-testid="verdict-simulation"
        className={`mt-4 rounded border p-3 text-sm ${
          decision.enregistrer
            ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
            : 'border-amber-300 bg-amber-50 text-amber-900'
        }`}
      >
        <p className="font-medium">
          {decision.enregistrer
            ? 'Cet appel serait enregistré.'
            : 'Cet appel ne serait pas enregistré.'}
        </p>
        <p className="mt-1">{decision.motif}</p>
        {(decision.annonce || decision.pauseAutorisee) && (
          <p className="mt-1 text-xs">
            {decision.annonce ? 'Annonce à l’appelant.' : ''}
            {decision.annonce && decision.pauseAutorisee ? ' ' : ''}
            {decision.pauseAutorisee ? 'Pause autorisée.' : ''}
          </p>
        )}
      </div>
    </section>
  );
}
