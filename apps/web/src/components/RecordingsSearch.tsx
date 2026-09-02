import { useState, type FormEvent } from 'react';
import { INGEST_DIRECTIONS, type RecordingFilters } from '@voxecho/shared';
import { libelleDirection } from '../lib/format';

/**
 * Formulaire de recherche — CLAUDE.md §6.
 *
 * La recherche part sur validation explicite, jamais à la frappe : chaque
 * appel à l'api écrit un `AuditEvent SEARCH`. Chercher à chaque caractère
 * noierait le journal sous des recherches que personne n'a faites, et c'est
 * ce journal qu'un contrôleur COBAC vient lire.
 */

interface Props {
  /** Filtres actuellement appliqués, pour réafficher le formulaire. */
  valeur: RecordingFilters;
  onRechercher: (filtres: RecordingFilters) => void;
  desactive?: boolean;
}

type Brouillon = Record<keyof RecordingFilters, string>;

const BROUILLON_VIDE: Brouillon = {
  phone: '',
  from: '',
  to: '',
  direction: '',
  minDurationSec: '',
  maxDurationSec: '',
};

const CHAMP =
  'w-full rounded border border-ardoise-300 bg-white px-2 py-1 text-sm ' +
  'focus:border-ardoise-500 focus:outline-none focus:ring-1 focus:ring-ardoise-500 ' +
  'disabled:bg-ardoise-50';

const ETIQUETTE = 'mb-1 block text-xs font-medium text-ardoise-700';

export function RecordingsSearch({ valeur, onRechercher, desactive = false }: Props) {
  const [brouillon, setBrouillon] = useState<Brouillon>(() => versBrouillon(valeur));

  const modifier = (champ: keyof Brouillon, saisie: string): void =>
    setBrouillon((actuel) => ({ ...actuel, [champ]: saisie }));

  const soumettre = (event: FormEvent): void => {
    event.preventDefault();
    onRechercher(versFiltres(brouillon));
  };

  const reinitialiser = (): void => {
    setBrouillon(BROUILLON_VIDE);
    onRechercher({});
  };

  const actifs = Object.values(brouillon).some((saisie) => saisie !== '');

  return (
    <form
      onSubmit={soumettre}
      aria-label="Recherche d’enregistrements"
      className="mb-4 rounded border border-ardoise-200 bg-ardoise-50 px-3 py-3"
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-6">
        <div className="lg:col-span-2">
          <label className={ETIQUETTE} htmlFor="recherche-numero">
            Numéro (poste ou correspondant)
          </label>
          <input
            id="recherche-numero"
            type="search"
            inputMode="tel"
            autoComplete="off"
            placeholder="1001 ou 699112233"
            className={CHAMP}
            value={brouillon.phone}
            disabled={desactive}
            onChange={(e) => modifier('phone', e.target.value)}
          />
        </div>

        <div>
          <label className={ETIQUETTE} htmlFor="recherche-du">
            Du
          </label>
          <input
            id="recherche-du"
            type="date"
            className={CHAMP}
            value={brouillon.from}
            disabled={desactive}
            onChange={(e) => modifier('from', e.target.value)}
          />
        </div>

        <div>
          <label className={ETIQUETTE} htmlFor="recherche-au">
            Au
          </label>
          <input
            id="recherche-au"
            type="date"
            className={CHAMP}
            value={brouillon.to}
            disabled={desactive}
            onChange={(e) => modifier('to', e.target.value)}
          />
        </div>

        <div>
          <label className={ETIQUETTE} htmlFor="recherche-sens">
            Sens
          </label>
          <select
            id="recherche-sens"
            className={CHAMP}
            value={brouillon.direction}
            disabled={desactive}
            onChange={(e) => modifier('direction', e.target.value)}
          >
            <option value="">Tous</option>
            {INGEST_DIRECTIONS.map((sens) => (
              <option key={sens} value={sens}>
                {libelleDirection(sens)}
              </option>
            ))}
          </select>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className={ETIQUETTE} htmlFor="recherche-duree-min">
              Durée min (s)
            </label>
            <input
              id="recherche-duree-min"
              type="number"
              min={0}
              step={1}
              className={CHAMP}
              value={brouillon.minDurationSec}
              disabled={desactive}
              onChange={(e) => modifier('minDurationSec', e.target.value)}
            />
          </div>
          <div>
            <label className={ETIQUETTE} htmlFor="recherche-duree-max">
              Durée max (s)
            </label>
            <input
              id="recherche-duree-max"
              type="number"
              min={0}
              step={1}
              className={CHAMP}
              value={brouillon.maxDurationSec}
              disabled={desactive}
              onChange={(e) => modifier('maxDurationSec', e.target.value)}
            />
          </div>
        </div>
      </div>

      <div className="mt-3 flex items-center gap-2">
        <button
          type="submit"
          disabled={desactive}
          className="rounded bg-ardoise-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-ardoise-800 disabled:opacity-50"
        >
          Rechercher
        </button>
        {actifs && (
          <button
            type="button"
            onClick={reinitialiser}
            disabled={desactive}
            className="rounded border border-ardoise-300 px-3 py-1.5 text-sm hover:bg-white disabled:opacity-50"
          >
            Réinitialiser
          </button>
        )}
      </div>
    </form>
  );
}

function versBrouillon(filtres: RecordingFilters): Brouillon {
  return {
    phone: filtres.phone ?? '',
    from: filtres.from ?? '',
    to: filtres.to ?? '',
    direction: filtres.direction ?? '',
    minDurationSec: filtres.minDurationSec?.toString() ?? '',
    maxDurationSec: filtres.maxDurationSec?.toString() ?? '',
  };
}

/**
 * Un champ vide n'est pas un critère : il est retiré plutôt qu'envoyé vide,
 * pour que le journal d'audit ne consigne que ce qui a réellement filtré.
 */
function versFiltres(brouillon: Brouillon): RecordingFilters {
  const filtres: RecordingFilters = {};
  if (brouillon.phone.trim()) filtres.phone = brouillon.phone.trim();
  if (brouillon.from) filtres.from = brouillon.from;
  if (brouillon.to) filtres.to = brouillon.to;
  if (brouillon.direction) {
    filtres.direction = brouillon.direction as RecordingFilters['direction'];
  }
  const min = Number.parseInt(brouillon.minDurationSec, 10);
  if (Number.isFinite(min)) filtres.minDurationSec = min;
  const max = Number.parseInt(brouillon.maxDurationSec, 10);
  if (Number.isFinite(max)) filtres.maxDurationSec = max;
  return filtres;
}
