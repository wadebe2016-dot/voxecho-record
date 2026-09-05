import { useCallback, useEffect, useState } from 'react';
import {
  RETENTION_SCOPE_ALL,
  type PurgeReportDetail,
  type PurgeReportSummary,
} from '@voxecho/shared';
import { ApiError, api, telecharger } from '../api/client';
import { useAuth } from '../auth/auth-context';
import { Aide } from '../components/Aide';
import {
  abregerEmpreinte,
  formatDuree,
  formatHorodatage,
  formatTaille,
  libelleCategorie,
} from '../lib/format';
import { peut } from '../lib/permissions';

/**
 * Purge — CLAUDE.md §9.7, §9.28 et §9.31.
 *
 * Le rapport est l'autorisation, pas un affichage : on énumère, on lit, on
 * exécute. L'écran suit cet ordre et ne propose jamais de détruire sans avoir
 * d'abord montré ce qui le serait — et ce qu'une conservation forcée épargne.
 */
export function PurgePage() {
  const { profil } = useAuth();
  const peutSimuler = peut(profil?.role, 'simulerPurge');
  const peutExecuter = peut(profil?.role, 'executerPurge');

  const [rapports, setRapports] = useState<PurgeReportSummary[]>([]);
  const [ouvert, setOuvert] = useState<PurgeReportDetail | null>(null);
  const [chargement, setChargement] = useState(true);
  const [erreur, setErreur] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [envoi, setEnvoi] = useState(false);
  const [motif, setMotif] = useState('');

  const charger = useCallback(async () => {
    setChargement(true);
    try {
      setRapports((await api.rapportsPurge()).items);
    } catch (e) {
      setErreur(e instanceof ApiError ? e.message : 'Le service est momentanément indisponible.');
    } finally {
      setChargement(false);
    }
  }, []);

  useEffect(() => {
    void charger();
  }, [charger]);

  async function ouvrir(id: string): Promise<void> {
    setErreur(null);
    try {
      setOuvert(await api.rapportPurge(id));
    } catch (e) {
      setErreur(e instanceof ApiError ? e.message : 'Le rapport n’a pas pu être ouvert.');
    }
  }

  async function agir(action: () => Promise<unknown>, succes: string): Promise<void> {
    setEnvoi(true);
    setErreur(null);
    setMessage(null);
    try {
      await action();
      setMessage(succes);
      setMotif('');
      await charger();
    } catch (e) {
      setErreur(e instanceof ApiError ? e.message : 'L’opération n’a pas abouti.');
    } finally {
      setEnvoi(false);
    }
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-lg font-semibold tracking-tight">
          Rapports de purge
          <Aide texte="Aucune purge ne se déclenche seule. Le produit énumère les appels échus, un responsable conformité valide, un administrateur exécute." />
        </h1>
        {peutSimuler && (
          <button
            type="button"
            disabled={envoi}
            onClick={() =>
              void agir(async () => {
                const rapport = await api.simulerPurge();
                await ouvrir(rapport.id);
              }, 'Rapport établi. Rien n’est détruit tant qu’il n’est pas exécuté.')
            }
            className="rounded border border-ardoise-300 px-3 py-1 text-sm hover:bg-ardoise-50 disabled:opacity-60"
          >
            Établir un rapport
          </button>
        )}
      </header>

      {message !== null && (
        <p
          role="status"
          className="rounded border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-900"
        >
          {message}
        </p>
      )}
      {erreur !== null && (
        <p
          role="alert"
          className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800"
        >
          {erreur}
        </p>
      )}

      {ouvert !== null && (
        <Rapport
          rapport={ouvert}
          peutExecuter={peutExecuter}
          envoi={envoi}
          motif={motif}
          onMotif={setMotif}
          onFermer={() => setOuvert(null)}
          onExecuter={() =>
            void agir(async () => {
              await api.executerPurge(ouvert.id, motif);
              await ouvrir(ouvert.id);
            }, 'Purge exécutée. Le certificat de destruction est disponible.')
          }
          onAnnuler={() =>
            void agir(async () => {
              await api.annulerPurge(ouvert.id);
              await ouvrir(ouvert.id);
            }, 'Rapport annulé.')
          }
          onErreur={setErreur}
        />
      )}

      <section aria-labelledby="historique-purge">
        <h2 id="historique-purge" className="mb-2 text-sm font-semibold">
          Historique
        </h2>
        {chargement ? (
          <p className="text-sm text-ardoise-600">Chargement des rapports…</p>
        ) : rapports.length === 0 ? (
          <p className="text-sm text-ardoise-600">Aucun rapport établi.</p>
        ) : (
          <table className="w-full border border-ardoise-200 bg-white text-sm">
            <thead className="bg-ardoise-50 text-left text-xs uppercase tracking-wide text-ardoise-600">
              <tr>
                <th className="px-3 py-2 font-medium">Établi le</th>
                <th className="px-3 py-2 font-medium">Par</th>
                <th className="px-3 py-2 font-medium">État</th>
                <th className="px-3 py-2 font-medium">Candidats</th>
                <th className="px-3 py-2 font-medium">Épargnés</th>
                <th className="px-3 py-2 font-medium">Détruits</th>
                <th className="px-3 py-2 font-medium">
                  <span className="sr-only">Ouvrir</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rapports.map((rapport) => (
                <tr key={rapport.id} className="border-t border-ardoise-100">
                  <td className="px-3 py-2">{formatHorodatage(rapport.createdAt)}</td>
                  <td className="px-3 py-2">{rapport.createdByEmail}</td>
                  <td className="px-3 py-2">{libelleEtat(rapport.status)}</td>
                  <td className="px-3 py-2 tabular-nums">
                    {rapport.candidateCount} · {formatTaille(rapport.candidateBytes)}
                  </td>
                  <td className="px-3 py-2 tabular-nums">{rapport.blockedCount}</td>
                  <td className="px-3 py-2 tabular-nums">{rapport.purgedCount ?? '—'}</td>
                  <td className="px-3 py-2 text-right">
                    <button
                      type="button"
                      onClick={() => void ouvrir(rapport.id)}
                      className="rounded border border-ardoise-300 px-2 py-1 text-xs hover:bg-ardoise-50"
                    >
                      Ouvrir
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

interface RapportProps {
  rapport: PurgeReportDetail;
  peutExecuter: boolean;
  envoi: boolean;
  motif: string;
  onMotif: (valeur: string) => void;
  onFermer: () => void;
  onExecuter: () => void;
  onAnnuler: () => void;
  onErreur: (message: string) => void;
}

function Rapport({
  rapport,
  peutExecuter,
  envoi,
  motif,
  onMotif,
  onFermer,
  onExecuter,
  onAnnuler,
  onErreur,
}: RapportProps) {
  const [format, setFormat] = useState<'pdf' | 'csv' | null>(null);
  const candidats = rapport.items.filter((item) => !item.blocked);
  const epargnes = rapport.items.filter((item) => item.blocked);

  async function telechargerCertificat(choix: 'pdf' | 'csv'): Promise<void> {
    setFormat(choix);
    try {
      telecharger(await api.certificatPurge(rapport.id, choix));
    } catch (e) {
      onErreur(e instanceof ApiError ? e.message : 'Le certificat n’a pas pu être produit.');
    } finally {
      setFormat(null);
    }
  }

  return (
    <section
      aria-labelledby="rapport-ouvert"
      className="rounded border border-ardoise-300 bg-white p-4"
    >
      <header className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="rapport-ouvert" className="text-base font-semibold tracking-tight">
          Rapport du {formatHorodatage(rapport.createdAt)} — {libelleEtat(rapport.status)}
        </h2>
        <button
          type="button"
          onClick={onFermer}
          className="rounded border border-ardoise-200 px-2 py-1 text-sm"
        >
          Fermer
        </button>
      </header>

      <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-4">
        <div>
          <dt className="text-xs uppercase tracking-wide text-ardoise-600">Établi par</dt>
          <dd>{rapport.createdByEmail}</dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-ardoise-600">Candidats</dt>
          <dd className="tabular-nums">
            {rapport.candidateCount} · {formatTaille(rapport.candidateBytes)}
          </dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-ardoise-600">
            Épargnés par une conservation
          </dt>
          <dd className="tabular-nums">{rapport.blockedCount}</dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-ardoise-600">Détruits</dt>
          <dd className="tabular-nums">
            {rapport.purgedCount === null
              ? '—'
              : `${rapport.purgedCount} · ${formatTaille(rapport.purgedBytes ?? 0)}`}
          </dd>
        </div>
      </dl>

      <div className="mt-3 border-t border-ardoise-100 pt-3 text-sm">
        <p className="text-xs uppercase tracking-wide text-ardoise-600">
          Durées figées par ce rapport
          <Aide texte="L’exécution rejoue ces durées, jamais celles du jour. Un rapport devient inexécutable dès qu’une seule d’entre elles a bougé." />
        </p>
        <p className="mt-1">
          {Object.entries(rapport.policyByScope)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(
              ([perimetre, jours]) =>
                `${perimetre === RETENTION_SCOPE_ALL ? 'Générale' : libelleCategorie(perimetre)} : ${jours} j`,
            )
            .join(' · ')}
        </p>
      </div>

      {rapport.status === 'executed' && (
        <div className="mt-3 rounded border border-ardoise-200 bg-ardoise-50 p-3">
          <p className="text-sm font-medium">Certificat de destruction</p>
          <p className="mt-1 text-xs text-ardoise-600">
            Téléchargement inscrit au journal d’audit.
            <Aide texte="Pièce de conformité à conserver : ce qui a été détruit, quand, au nom de quelle durée et sur l’ordre de qui. Le PDF et le CSV portent la même empreinte." />
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              disabled={format !== null}
              onClick={() => void telechargerCertificat('pdf')}
              className="rounded border border-ardoise-300 px-3 py-1 text-sm hover:bg-white disabled:opacity-60"
            >
              {format === 'pdf' ? 'Préparation…' : 'Télécharger en PDF'}
            </button>
            <button
              type="button"
              disabled={format !== null}
              onClick={() => void telechargerCertificat('csv')}
              className="rounded border border-ardoise-300 px-3 py-1 text-sm hover:bg-white disabled:opacity-60"
            >
              {format === 'csv' ? 'Préparation…' : 'Télécharger en CSV'}
            </button>
          </div>
          {rapport.certificateSha256 !== null && (
            <p className="mt-2 break-all font-mono text-xs text-ardoise-600">
              empreinte {rapport.certificateSha256}
            </p>
          )}
        </div>
      )}

      {rapport.status === 'simulated' && peutExecuter && (
        <div className="mt-3 border-t border-ardoise-100 pt-3">
          <label className="block text-xs font-medium text-ardoise-700" htmlFor="motif-purge">
            Motif de la destruction
            <Aide texte="Détruire des pièces probantes est le seul acte irréversible du produit. Le motif est porté au journal, sur chaque enregistrement détruit." />
          </label>
          <input
            id="motif-purge"
            value={motif}
            onChange={(e) => onMotif(e.target.value)}
            placeholder="Échéance de conservation atteinte"
            className="mt-1 w-full rounded border border-ardoise-300 px-2 py-1 text-sm"
          />
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              disabled={envoi || motif.trim().length < 10}
              onClick={onExecuter}
              className="rounded bg-red-700 px-3 py-1 text-sm font-medium text-white disabled:opacity-60"
            >
              Exécuter — {rapport.candidateCount} enregistrement(s) détruit(s)
            </button>
            <button
              type="button"
              disabled={envoi}
              onClick={onAnnuler}
              className="rounded border border-ardoise-300 px-3 py-1 text-sm disabled:opacity-60"
            >
              Annuler le rapport
            </button>
          </div>
        </div>
      )}

      <Lignes
        titre="Appels à détruire"
        items={candidats}
        vide="Aucun appel échu à cette échéance."
      />
      {/* La section demeure même vide : un auditeur veut voir ce qui a échappé
          à la purge, et pourquoi. */}
      <Lignes
        titre="Épargnés par une conservation forcée"
        items={epargnes}
        vide="Aucune conservation forcée n’a épargné d’appel."
        motif
      />
    </section>
  );
}

function Lignes({
  titre,
  items,
  vide,
  motif = false,
}: {
  titre: string;
  items: PurgeReportDetail['items'];
  vide: string;
  motif?: boolean;
}) {
  return (
    <section className="mt-4">
      <h3 className="mb-2 text-xs uppercase tracking-wide text-ardoise-600">
        {titre} ({items.length})
      </h3>
      {items.length === 0 ? (
        <p className="text-sm text-ardoise-600">{vide}</p>
      ) : (
        <table className="w-full border border-ardoise-200 text-sm">
          <thead className="bg-ardoise-50 text-left text-xs uppercase tracking-wide text-ardoise-600">
            <tr>
              <th className="px-3 py-2 font-medium">Appel</th>
              <th className="px-3 py-2 font-medium">Date</th>
              <th className="px-3 py-2 font-medium">Durée</th>
              <th className="px-3 py-2 font-medium">Catégorie</th>
              <th className="px-3 py-2 font-medium">Conservation</th>
              <th className="px-3 py-2 font-medium">Empreinte</th>
              {motif && <th className="px-3 py-2 font-medium">Motif</th>}
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.recordingId} className="border-t border-ardoise-100">
                <td className="px-3 py-2 tabular-nums">{item.refci}</td>
                <td className="px-3 py-2">{formatHorodatage(item.startedAt)}</td>
                <td className="px-3 py-2 tabular-nums">{formatDuree(item.durationSec)}</td>
                <td className="px-3 py-2">
                  {item.operationCategory === null ? '—' : libelleCategorie(item.operationCategory)}
                </td>
                <td className="px-3 py-2 tabular-nums">
                  {item.policyDays === null ? '—' : `${item.policyDays} j`}
                </td>
                <td className="px-3 py-2 font-mono text-xs" title={item.sha256}>
                  {abregerEmpreinte(item.sha256)}
                </td>
                {motif && (
                  <td className="px-3 py-2 text-ardoise-700">{item.blockingReason ?? '—'}</td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

const ETATS: Record<string, string> = {
  simulated: 'simulé',
  executed: 'exécuté',
  cancelled: 'annulé',
};

function libelleEtat(statut: string): string {
  return ETATS[statut] ?? statut;
}
