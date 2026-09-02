import { useState } from 'react';
import type { DashboardJour } from '@voxecho/shared';
import { formatDuree, formatTaille } from '../lib/format';

interface Props {
  jours: DashboardJour[];
}

/**
 * Volume quotidien — CLAUDE.md §6.
 *
 * Une seule série : le nombre d'appels par journée de Douala. Donc une seule
 * teinte, pas de légende — le titre nomme la série — et l'accent du produit
 * suffit. Les jours creux sont dessinés à zéro plutôt qu'omis : un graphe qui
 * saute les jours vides dessine une activité continue là où le service a
 * chômé.
 *
 * La même donnée est disponible en tableau juste en dessous : la couleur n'est
 * jamais le seul porteur d'information.
 */
export function VolumeParJour({ jours }: Props) {
  const [survole, setSurvole] = useState<DashboardJour | null>(null);

  const maximum = Math.max(...jours.map((jour) => jour.appels), 1);
  const total = jours.reduce((somme, jour) => somme + jour.appels, 0);
  const [premier, dernier] = [jours.at(0), jours.at(-1)];

  return (
    <section
      aria-labelledby="volume-titre"
      className="rounded border border-ardoise-200 bg-white p-4"
    >
      <header className="mb-1 flex items-baseline justify-between gap-3">
        <h2 id="volume-titre" className="text-sm font-semibold tracking-tight">
          Appels ingérés par jour
        </h2>
        <span className="text-xs text-ardoise-600">
          {jours.length} derniers jours · {total} appel{total > 1 ? 's' : ''}
        </span>
      </header>

      {/* Zone de survol : la cible est la colonne entière, pas la seule barre,
          pour qu'un jour creux reste atteignable. */}
      <div className="mt-3 flex h-32 items-end gap-[2px]" onMouseLeave={() => setSurvole(null)}>
        {jours.map((jour) => (
          <button
            key={jour.jour}
            type="button"
            onMouseEnter={() => setSurvole(jour)}
            onFocus={() => setSurvole(jour)}
            onBlur={() => setSurvole(null)}
            aria-label={`${jour.jour} : ${jour.appels} appel${jour.appels > 1 ? 's' : ''}`}
            className="group flex h-full flex-1 cursor-default flex-col justify-end"
          >
            <span
              className="w-full rounded-t bg-accent-600 transition-colors group-hover:bg-accent-700 group-focus:bg-accent-700"
              style={{
                // Une hauteur minimale visible pour un jour à zéro dirait
                // qu'il s'est passé quelque chose : zéro reste zéro.
                height: jour.appels === 0 ? '0' : `${Math.max(4, (jour.appels / maximum) * 100)}%`,
              }}
            />
          </button>
        ))}
      </div>

      <div className="mt-1 flex justify-between text-xs text-ardoise-600 tabular-nums">
        <span>{premier?.jour}</span>
        <span>{dernier?.jour}</span>
      </div>

      <p role="status" aria-live="polite" className="mt-2 min-h-[1.25rem] text-xs text-ardoise-600">
        {survole === null ? (
          <span className="text-ardoise-400">Survolez une journée pour son détail.</span>
        ) : (
          <>
            <span className="font-medium text-ardoise-900">{survole.jour}</span> — {survole.appels}{' '}
            appel{survole.appels > 1 ? 's' : ''}
            {survole.appels > 0 && (
              <>
                {' '}
                · {formatDuree(survole.dureeSec)} · {formatTaille(survole.octets)}
              </>
            )}
          </>
        )}
      </p>
    </section>
  );
}
