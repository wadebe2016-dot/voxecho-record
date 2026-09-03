import { useCallback, useEffect, useState } from 'react';
import type { Page, RecordingFilters, RecordingListItem } from '@voxecho/shared';
import { ApiError, api } from '../api/client';
import { RecordingDetail } from '../components/RecordingDetail';
import { RecordingsSearch } from '../components/RecordingsSearch';
import {
  abregerEmpreinte,
  formatDuree,
  formatHorodatage,
  formatTaille,
  libelleDirection,
  libelleStatut,
} from '../lib/format';

const TAILLE_PAGE = 25;

/** Aucun critère : la liste montre tout ce que le locataire a le droit de voir. */
const AUCUN_FILTRE: RecordingFilters = {};

export function RecordingsPage() {
  const [page, setPage] = useState(1);
  const [filtres, setFiltres] = useState<RecordingFilters>(AUCUN_FILTRE);
  const [donnees, setDonnees] = useState<Page<RecordingListItem> | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [chargement, setChargement] = useState(true);
  /** Appel dont la fiche est ouverte. L'ouvrir ne déclenche aucune écoute. */
  const [consulte, setConsulte] = useState<RecordingListItem | null>(null);

  const charger = useCallback(async (numero: number, criteres: RecordingFilters) => {
    setChargement(true);
    setErreur(null);
    try {
      setDonnees(await api.enregistrements({ ...criteres, page: numero, pageSize: TAILLE_PAGE }));
    } catch (e) {
      setErreur(e instanceof ApiError ? e.message : 'Le service est momentanément indisponible.');
    } finally {
      setChargement(false);
    }
  }, []);

  useEffect(() => {
    void charger(page, filtres);
  }, [charger, page, filtres]);

  /** Une nouvelle recherche repart de la première page. */
  const rechercher = (criteres: RecordingFilters): void => {
    setPage(1);
    setFiltres(criteres);
    // La fiche ouverte ne survit pas à une nouvelle recherche : elle ne
    // figure peut-être plus dans les résultats.
    setConsulte(null);
  };

  const filtree = Object.keys(filtres).length > 0;

  return (
    <section>
      <header className="mb-4 flex items-baseline gap-3">
        <h1 className="text-lg font-semibold tracking-tight">Enregistrements</h1>
        {donnees !== null && (
          <span className="text-sm text-ardoise-600">
            {donnees.total} {donnees.total > 1 ? 'appels' : 'appel'}
            {filtree && ' correspondant aux critères'}
          </span>
        )}
      </header>

      <RecordingsSearch valeur={filtres} onRechercher={rechercher} desactive={chargement} />

      {consulte !== null && <RecordingDetail appel={consulte} onFermer={() => setConsulte(null)} />}

      {erreur !== null && (
        <p
          role="alert"
          className="mb-4 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800"
        >
          {erreur}
        </p>
      )}

      <div className="overflow-x-auto rounded border border-ardoise-200 bg-white">
        <table className="w-full border-collapse text-sm">
          <caption className="sr-only">Liste des appels enregistrés</caption>
          <thead className="bg-ardoise-100 text-left text-xs uppercase tracking-wide text-ardoise-600">
            <tr>
              <th scope="col" className="px-3 py-2 font-medium">
                Date et heure
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Sens
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Poste
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Correspondant
              </th>
              <th scope="col" className="px-3 py-2 text-right font-medium">
                Durée
              </th>
              <th scope="col" className="px-3 py-2 text-right font-medium">
                Taille
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Empreinte SHA-256
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Statut
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                <span className="sr-only">Consulter</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {chargement && (
              <tr>
                <td colSpan={9} className="px-3 py-8 text-center text-ardoise-600">
                  Chargement…
                </td>
              </tr>
            )}

            {!chargement && donnees?.items.length === 0 && (
              <tr>
                <td colSpan={9} className="px-3 py-10 text-center">
                  <p className="font-medium">
                    {filtree ? 'Aucun appel ne correspond' : 'Aucun enregistrement'}
                  </p>
                  <p className="mt-1 text-sm text-ardoise-600">
                    {filtree
                      ? 'Aucun appel de ce locataire ne répond à ces critères.'
                      : 'Aucun appel n’a encore été ingéré pour ce locataire.'}
                  </p>
                </td>
              </tr>
            )}

            {!chargement &&
              donnees?.items.map((item) => (
                <tr key={item.id} className="border-t border-ardoise-100">
                  <td className="px-3 py-1.5 whitespace-nowrap">
                    {formatHorodatage(item.startedAt)}
                  </td>
                  <td className="px-3 py-1.5">{libelleDirection(item.direction)}</td>
                  <td className="px-3 py-1.5">{item.near}</td>
                  <td className="px-3 py-1.5">{item.far}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">
                    {formatDuree(item.durationSec)}
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums">
                    {formatTaille(item.sizeBytes)}
                  </td>
                  <td className="px-3 py-1.5 font-mono text-xs" title={item.sha256}>
                    {abregerEmpreinte(item.sha256)}
                  </td>
                  <td className="px-3 py-1.5 whitespace-nowrap">
                    {libelleStatut(item.status)}
                    {item.underHold && (
                      <span
                        className="ml-1.5 rounded border border-amber-300 bg-amber-50 px-1.5 py-0.5 text-xs text-amber-900"
                        title="Soustrait à la purge automatique jusqu’à la levée de la mesure"
                      >
                        conservation forcée
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-1.5 text-right">
                    <button
                      type="button"
                      onClick={() => setConsulte(item)}
                      aria-label={`Consulter l’appel ${item.refci} du ${formatHorodatage(item.startedAt)}`}
                      className="rounded border border-ardoise-200 px-2 py-0.5 text-xs"
                    >
                      Consulter
                    </button>
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>

      {donnees !== null && donnees.pageCount > 1 && (
        <nav className="mt-3 flex items-center gap-3 text-sm" aria-label="Pagination">
          <button
            type="button"
            onClick={() => setPage((n) => Math.max(1, n - 1))}
            disabled={page <= 1}
            className="rounded border border-ardoise-200 px-2 py-1 disabled:opacity-50"
          >
            Précédent
          </button>
          <span className="text-ardoise-600">
            Page {donnees.page} sur {donnees.pageCount}
          </span>
          <button
            type="button"
            onClick={() => setPage((n) => Math.min(donnees.pageCount, n + 1))}
            disabled={page >= donnees.pageCount}
            className="rounded border border-ardoise-200 px-2 py-1 disabled:opacity-50"
          >
            Suivant
          </button>
        </nav>
      )}
    </section>
  );
}
