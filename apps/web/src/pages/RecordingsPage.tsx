import { useCallback, useEffect, useState } from 'react';
import type { Page, RecordingListItem } from '@voxecho/shared';
import { ApiError, api } from '../api/client';
import {
  abregerEmpreinte,
  formatDuree,
  formatHorodatage,
  formatTaille,
  libelleDirection,
  libelleStatut,
} from '../lib/format';

const TAILLE_PAGE = 25;

export function RecordingsPage() {
  const [page, setPage] = useState(1);
  const [donnees, setDonnees] = useState<Page<RecordingListItem> | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [chargement, setChargement] = useState(true);

  const charger = useCallback(async (numero: number) => {
    setChargement(true);
    setErreur(null);
    try {
      setDonnees(await api.enregistrements({ page: numero, pageSize: TAILLE_PAGE }));
    } catch (e) {
      setErreur(e instanceof ApiError ? e.message : 'Le service est momentanément indisponible.');
    } finally {
      setChargement(false);
    }
  }, []);

  useEffect(() => {
    void charger(page);
  }, [charger, page]);

  return (
    <section>
      <header className="mb-4 flex items-baseline gap-3">
        <h1 className="text-lg font-semibold tracking-tight">Enregistrements</h1>
        {donnees !== null && (
          <span className="text-sm text-ardoise-600">
            {donnees.total} {donnees.total > 1 ? 'appels' : 'appel'}
          </span>
        )}
      </header>

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
            </tr>
          </thead>
          <tbody>
            {chargement && (
              <tr>
                <td colSpan={8} className="px-3 py-8 text-center text-ardoise-600">
                  Chargement…
                </td>
              </tr>
            )}

            {!chargement && donnees?.items.length === 0 && (
              <tr>
                <td colSpan={8} className="px-3 py-10 text-center">
                  <p className="font-medium">Aucun enregistrement</p>
                  <p className="mt-1 text-sm text-ardoise-600">
                    Aucun appel n’a encore été ingéré pour ce locataire.
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
                  <td className="px-3 py-1.5">{libelleStatut(item.status)}</td>
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
            Précédente
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
            Suivante
          </button>
        </nav>
      )}
    </section>
  );
}
