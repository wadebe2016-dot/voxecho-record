import { useEffect, useState } from 'react';
import type { DashboardResponse } from '@voxecho/shared';
import { ApiError, api } from '../api/client';
import { VolumeParJour } from '../components/VolumeParJour';
import { formatDuree, formatHorodatage, formatTaille } from '../lib/format';

/**
 * Tableau de bord — CLAUDE.md §6.
 *
 * Sobre : des chiffres d'exploitation, pas une vitrine. Il répond à « la
 * chaîne tourne-t-elle » et « que pèse la conservation ». Ce qu'il ne dit pas,
 * volontairement : qui a écouté quoi — cela relève du journal d'audit.
 */
export function TableauDeBordPage() {
  const [donnees, setDonnees] = useState<DashboardResponse | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [chargement, setChargement] = useState(true);

  useEffect(() => {
    let vivant = true;
    void (async () => {
      try {
        const reponse = await api.tableauDeBord();
        if (vivant) setDonnees(reponse);
      } catch (e) {
        if (vivant) {
          setErreur(
            e instanceof ApiError
              ? e.message
              : 'Le tableau de bord est momentanément indisponible.',
          );
        }
      } finally {
        if (vivant) setChargement(false);
      }
    })();
    return () => {
      vivant = false;
    };
  }, []);

  if (chargement) {
    return <p className="text-sm text-ardoise-600">Chargement…</p>;
  }

  if (erreur !== null) {
    return (
      <p
        role="alert"
        className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800"
      >
        {erreur}
      </p>
    );
  }

  if (donnees === null) return null;

  const { totaux, retention, volumeParJour, quarantaines } = donnees;

  return (
    <section>
      <h1 className="mb-4 text-lg font-semibold tracking-tight">Tableau de bord</h1>

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Chiffre intitule="Appels conservés" valeur={totaux.appelsConserves.toLocaleString('fr')} />
        <Chiffre intitule="Durée totale" valeur={formatDuree(totaux.dureeSec)} />
        <Chiffre intitule="Stockage utilisé" valeur={formatTaille(totaux.stockageOctets)} />
        <Chiffre
          intitule="Sous conservation forcée"
          valeur={totaux.sousConservationForcee.toLocaleString('fr')}
        />
        <Chiffre
          intitule="Appels purgés"
          valeur={totaux.appelsPurges.toLocaleString('fr')}
          note="fiche conservée, audio détruit"
        />
      </div>

      <p className="mb-4 rounded border border-ardoise-200 bg-white px-3 py-2 text-sm">
        Conservation en vigueur : <span className="font-medium">{retention.days} jours</span>.
        {retention.belowFloorReason !== null && (
          /* Une politique dérogatoire doit se voir avant tout le reste : c'est
             ce qu'un contrôleur lit en premier (§9.6). */
          <span className="ml-2 rounded border border-amber-300 bg-amber-50 px-1.5 py-0.5 text-xs text-amber-900">
            dérogation au plancher — {retention.belowFloorReason}
          </span>
        )}
      </p>

      <div className="mb-4">
        <VolumeParJour jours={volumeParJour} />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <JoursChiffres jours={volumeParJour} />
        <Quarantaines quarantaines={quarantaines} />
      </div>
    </section>
  );
}

function Chiffre({ intitule, valeur, note }: { intitule: string; valeur: string; note?: string }) {
  return (
    <div className="rounded border border-ardoise-200 bg-white px-3 py-2">
      <dt className="text-xs uppercase tracking-wide text-ardoise-600">{intitule}</dt>
      <dd className="mt-0.5 text-xl font-semibold tabular-nums">{valeur}</dd>
      {note !== undefined && <p className="mt-0.5 text-xs text-ardoise-600">{note}</p>}
    </div>
  );
}

/**
 * Le graphe en chiffres. Un contrôleur recopie des valeurs ; il ne mesure pas
 * des barres à l'œil, et la couleur ne doit jamais porter seule l'information.
 */
function JoursChiffres({ jours }: { jours: DashboardResponse['volumeParJour'] }) {
  const charges = jours.filter((jour) => jour.appels > 0).reverse();

  return (
    <section
      aria-labelledby="jours-titre"
      className="rounded border border-ardoise-200 bg-white p-4"
    >
      <h2 id="jours-titre" className="mb-2 text-sm font-semibold tracking-tight">
        Détail des journées
      </h2>
      {charges.length === 0 ? (
        <p className="text-sm text-ardoise-600">Aucun appel ingéré sur la période.</p>
      ) : (
        <div className="max-h-64 overflow-y-auto">
          <table className="w-full border-collapse text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-ardoise-600">
              <tr>
                <th scope="col" className="py-1 font-medium">
                  Jour
                </th>
                <th scope="col" className="py-1 text-right font-medium">
                  Appels
                </th>
                <th scope="col" className="py-1 text-right font-medium">
                  Durée
                </th>
                <th scope="col" className="py-1 text-right font-medium">
                  Volume
                </th>
              </tr>
            </thead>
            <tbody>
              {charges.map((jour) => (
                <tr key={jour.jour} className="border-t border-ardoise-100">
                  <td className="py-1 tabular-nums">{jour.jour}</td>
                  <td className="py-1 text-right tabular-nums">{jour.appels}</td>
                  <td className="py-1 text-right tabular-nums">{formatDuree(jour.dureeSec)}</td>
                  <td className="py-1 text-right tabular-nums">{formatTaille(jour.octets)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function Quarantaines({ quarantaines }: { quarantaines: DashboardResponse['quarantaines'] }) {
  return (
    <section
      aria-labelledby="quarantaines-titre"
      className="rounded border border-ardoise-200 bg-white p-4"
    >
      <h2 id="quarantaines-titre" className="mb-2 text-sm font-semibold tracking-tight">
        Dernières quarantaines
      </h2>
      {quarantaines.length === 0 ? (
        /* Distinguer « rien à signaler » de « on ne sait pas » : un tableau
           vide sans phrase se lit comme une panne d'affichage. */
        <p className="text-sm text-ardoise-600">
          Aucun dépôt écarté récemment. Tout ce qui a été déposé est entré en conservation.
        </p>
      ) : (
        <ul className="divide-y divide-ardoise-100 text-sm">
          {quarantaines.map((quarantaine) => (
            <li key={quarantaine.id} className="py-1.5">
              <span className="text-ardoise-600 tabular-nums">
                {formatHorodatage(quarantaine.at)}
              </span>
              <span className="ml-2">{quarantaine.motif}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
