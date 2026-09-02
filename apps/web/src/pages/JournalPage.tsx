import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { AUDIT_ACTIONS, type AuditEventItem, type AuditFilters, type Page } from '@voxecho/shared';
import { ApiError, api, telecharger } from '../api/client';
import { useAuth } from '../auth/auth-context';
import { formatHorodatage, libelleAction } from '../lib/format';

const TAILLE_PAGE = 50;
const AUCUN_FILTRE: AuditFilters = {};

const CHAMP =
  'w-full rounded border border-ardoise-300 bg-white px-2 py-1 text-sm ' +
  'focus:border-ardoise-500 focus:outline-none focus:ring-1 focus:ring-ardoise-500 ' +
  'disabled:bg-ardoise-50';
const ETIQUETTE = 'mb-1 block text-xs font-medium text-ardoise-700';

/**
 * Journal d'audit — CLAUDE.md §6.
 *
 * L'écran que vient lire un contrôleur. Il répond à « qui a fait quoi, quand,
 * sur quoi, depuis où » ; le détail de chaque acte est déplié tel qu'il a été
 * consigné, sans reformulation — ce que le journal dit est ce qui a été écrit
 * au moment des faits.
 */
export function JournalPage() {
  const { profil } = useAuth();
  const estAdmin = profil?.role === 'ADMIN';

  const [page, setPage] = useState(1);
  const [filtres, setFiltres] = useState<AuditFilters>(AUCUN_FILTRE);
  const [donnees, setDonnees] = useState<Page<AuditEventItem> | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [chargement, setChargement] = useState(true);
  const [extraction, setExtraction] = useState(false);

  const charger = useCallback(async (numero: number, criteres: AuditFilters) => {
    setChargement(true);
    setErreur(null);
    try {
      setDonnees(await api.journal({ ...criteres, page: numero, pageSize: TAILLE_PAGE }));
    } catch (e) {
      setErreur(e instanceof ApiError ? e.message : 'Le journal est momentanément indisponible.');
    } finally {
      setChargement(false);
    }
  }, []);

  useEffect(() => {
    void charger(page, filtres);
  }, [charger, page, filtres]);

  const appliquer = (criteres: AuditFilters): void => {
    setPage(1);
    setFiltres(criteres);
  };

  const extraire = async (): Promise<void> => {
    setExtraction(true);
    setErreur(null);
    try {
      telecharger(await api.exporterJournal(filtres));
    } catch (e) {
      setErreur(e instanceof ApiError ? e.message : 'L’extraction est momentanément indisponible.');
    } finally {
      setExtraction(false);
    }
  };

  return (
    <section>
      <header className="mb-4 flex items-baseline gap-3">
        <h1 className="text-lg font-semibold tracking-tight">Journal d’audit</h1>
        {donnees !== null && (
          <span className="text-sm text-ardoise-600">
            {donnees.total} {donnees.total > 1 ? 'événements' : 'événement'}
          </span>
        )}
      </header>

      <Filtres valeur={filtres} onFiltrer={appliquer} desactive={chargement} estAdmin={estAdmin} />

      {erreur !== null && (
        <p
          role="alert"
          className="mb-4 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800"
        >
          {erreur}
        </p>
      )}

      <div className="mb-3 flex items-center gap-3">
        <button
          type="button"
          onClick={() => void extraire()}
          disabled={extraction || chargement}
          className="rounded border border-ardoise-300 px-3 py-1.5 text-sm disabled:opacity-50"
        >
          {extraction ? 'Extraction…' : 'Extraire en CSV'}
        </button>
        <span className="text-xs text-ardoise-600">
          L’extrait reprend les filtres ci-dessus. Il est lui-même inscrit au journal.
        </span>
      </div>

      <div className="overflow-x-auto rounded border border-ardoise-200 bg-white">
        <table className="w-full border-collapse text-sm">
          <caption className="sr-only">Journal d’audit</caption>
          <thead className="bg-ardoise-100 text-left text-xs uppercase tracking-wide text-ardoise-600">
            <tr>
              <th scope="col" className="px-3 py-2 font-medium">
                Horodatage
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Action
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Auteur
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Appel
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Adresse IP
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Détail
              </th>
            </tr>
          </thead>
          <tbody>
            {chargement && (
              <tr>
                <td colSpan={6} className="px-3 py-8 text-center text-ardoise-600">
                  Chargement…
                </td>
              </tr>
            )}

            {!chargement && donnees?.items.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-10 text-center">
                  <p className="font-medium">Aucun événement</p>
                  <p className="mt-1 text-sm text-ardoise-600">
                    Aucun acte ne répond à ces critères.
                  </p>
                </td>
              </tr>
            )}

            {!chargement &&
              donnees?.items.map((item) => (
                <tr key={item.id} className="border-t border-ardoise-100 align-top">
                  <td className="px-3 py-1.5 whitespace-nowrap">{formatHorodatage(item.at)}</td>
                  <td className="px-3 py-1.5 whitespace-nowrap">
                    {libelleAction(item.action)}
                    {item.tenantId === null && (
                      <span
                        className="ml-1.5 rounded border border-ardoise-300 px-1.5 py-0.5 text-xs"
                        title="Événement qu’aucun locataire ne réclame"
                      >
                        système
                      </span>
                    )}
                  </td>
                  {/* Ce que fait le produit lui-même n'a pas d'auteur humain :
                      on l'écrit, plutôt que de laisser une case vide. */}
                  <td className="px-3 py-1.5">
                    {item.actorEmail ?? <span className="text-ardoise-500">le système</span>}
                  </td>
                  <td className="px-3 py-1.5">{item.recordingRefci ?? '—'}</td>
                  <td className="px-3 py-1.5 tabular-nums">{item.ip ?? '—'}</td>
                  <td className="px-3 py-1.5">
                    {item.detail === null ? (
                      '—'
                    ) : (
                      <code className="font-mono text-xs break-all text-ardoise-700">
                        {JSON.stringify(item.detail)}
                      </code>
                    )}
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
            disabled={page <= 1 || chargement}
            className="rounded border border-ardoise-300 px-2 py-1 disabled:opacity-40"
          >
            Précédent
          </button>
          <span className="tabular-nums">
            Page {donnees.page} sur {donnees.pageCount}
          </span>
          <button
            type="button"
            onClick={() => setPage((n) => Math.min(donnees.pageCount, n + 1))}
            disabled={page >= donnees.pageCount || chargement}
            className="rounded border border-ardoise-300 px-2 py-1 disabled:opacity-40"
          >
            Suivant
          </button>
        </nav>
      )}
    </section>
  );
}

interface FiltresProps {
  valeur: AuditFilters;
  onFiltrer: (filtres: AuditFilters) => void;
  desactive: boolean;
  estAdmin: boolean;
}

type Brouillon = { action: string; actor: string; from: string; to: string; scope: string };

const BROUILLON_VIDE: Brouillon = { action: '', actor: '', from: '', to: '', scope: '' };

function Filtres({ valeur, onFiltrer, desactive, estAdmin }: FiltresProps) {
  const [brouillon, setBrouillon] = useState<Brouillon>(() => ({
    action: valeur.action ?? '',
    actor: valeur.actor ?? '',
    from: valeur.from ?? '',
    to: valeur.to ?? '',
    scope: valeur.scope ?? '',
  }));

  const modifier = (champ: keyof Brouillon, saisie: string): void =>
    setBrouillon((actuel) => ({ ...actuel, [champ]: saisie }));

  const soumettre = (event: FormEvent): void => {
    event.preventDefault();
    const filtres: AuditFilters = {};
    if (brouillon.action) filtres.action = brouillon.action as AuditFilters['action'];
    if (brouillon.actor.trim()) filtres.actor = brouillon.actor.trim();
    if (brouillon.from) filtres.from = brouillon.from;
    if (brouillon.to) filtres.to = brouillon.to;
    if (brouillon.scope) filtres.scope = brouillon.scope as AuditFilters['scope'];
    onFiltrer(filtres);
  };

  const actifs = Object.values(brouillon).some((saisie) => saisie !== '');

  return (
    <form
      onSubmit={soumettre}
      aria-label="Filtres du journal"
      className="mb-4 rounded border border-ardoise-200 bg-ardoise-50 px-3 py-3"
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <div>
          <label className={ETIQUETTE} htmlFor="journal-action">
            Action
          </label>
          <select
            id="journal-action"
            className={CHAMP}
            value={brouillon.action}
            disabled={desactive}
            onChange={(e) => modifier('action', e.target.value)}
          >
            <option value="">Toutes</option>
            {AUDIT_ACTIONS.map((action) => (
              <option key={action} value={action}>
                {libelleAction(action)}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className={ETIQUETTE} htmlFor="journal-auteur">
            Auteur
          </label>
          <input
            id="journal-auteur"
            type="search"
            autoComplete="off"
            placeholder="auditeur@…"
            className={CHAMP}
            value={brouillon.actor}
            disabled={desactive}
            onChange={(e) => modifier('actor', e.target.value)}
          />
        </div>

        <div>
          <label className={ETIQUETTE} htmlFor="journal-du">
            Du
          </label>
          <input
            id="journal-du"
            type="date"
            className={CHAMP}
            value={brouillon.from}
            disabled={desactive}
            onChange={(e) => modifier('from', e.target.value)}
          />
        </div>

        <div>
          <label className={ETIQUETTE} htmlFor="journal-au">
            Au
          </label>
          <input
            id="journal-au"
            type="date"
            className={CHAMP}
            value={brouillon.to}
            disabled={desactive}
            onChange={(e) => modifier('to', e.target.value)}
          />
        </div>

        {/* Les événements que nul locataire ne réclame ne regardent que
            l'administrateur de l'instance (§9.2). */}
        {estAdmin && (
          <div>
            <label className={ETIQUETTE} htmlFor="journal-perimetre">
              Périmètre
            </label>
            <select
              id="journal-perimetre"
              className={CHAMP}
              value={brouillon.scope}
              disabled={desactive}
              onChange={(e) => modifier('scope', e.target.value)}
            >
              <option value="">Ce locataire</option>
              <option value="all">Locataire et système</option>
              <option value="system">Système seul</option>
            </select>
          </div>
        )}
      </div>

      <div className="mt-3 flex items-center gap-2">
        <button
          type="submit"
          disabled={desactive}
          className="rounded bg-ardoise-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-ardoise-800 disabled:opacity-50"
        >
          Filtrer
        </button>
        {actifs && (
          <button
            type="button"
            onClick={() => {
              setBrouillon(BROUILLON_VIDE);
              onFiltrer({});
            }}
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
