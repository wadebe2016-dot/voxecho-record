import { useCallback, useEffect, useState } from 'react';
import {
  parseRecordingPolicy,
  politiqueParDefaut,
  type PolicyVersionDetail,
  type PolicyVersionSummary,
  type RecordingPolicy,
} from '@voxecho/shared';
import { ApiError, api } from '../api/client';
import { useAuth } from '../auth/auth-context';
import { EditeurPolitique } from '../components/EditeurPolitique';
import { formatHorodatage } from '../lib/format';
import { peut } from '../lib/permissions';

/**
 * Politiques d'enregistrement — CLAUDE.md §9.23.
 *
 * Trois choses sur un même écran, dans cet ordre : ce qui s'applique
 * aujourd'hui, ce qu'on prépare, et ce qui s'est appliqué avant. La dernière
 * n'est pas un ornement : le jour où le produit cesse d'enregistrer
 * systématiquement, « quelle politique s'appliquait le 12 mars ? » devient une
 * question de contrôle, et elle doit se lire sans demander à l'exploitant.
 */
export function PolitiquesPage() {
  const { profil } = useAuth();
  const peutGerer = peut(profil?.role, 'gererPolitiques');

  const [enVigueur, setEnVigueur] = useState<PolicyVersionDetail | null>(null);
  const [versions, setVersions] = useState<PolicyVersionSummary[]>([]);
  const [brouillon, setBrouillon] = useState<RecordingPolicy | null>(null);
  const [note, setNote] = useState('');
  const [erreurs, setErreurs] = useState<string[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [chargement, setChargement] = useState(true);
  const [envoi, setEnvoi] = useState(false);

  const charger = useCallback(async () => {
    setChargement(true);
    try {
      const [appliquee, historique, enPreparation] = await Promise.all([
        api.politiqueEnVigueur(),
        api.politiques(),
        peutGerer ? api.politiqueBrouillon() : Promise.resolve(null),
      ]);
      setEnVigueur(appliquee);
      setVersions(historique);
      setBrouillon(enPreparation?.document ?? null);
    } catch (e) {
      setErreurs([
        e instanceof ApiError ? e.message : 'Le service est momentanément indisponible.',
      ]);
    } finally {
      setChargement(false);
    }
  }, [peutGerer]);

  useEffect(() => {
    void charger();
  }, [charger]);

  async function enregistrer(): Promise<void> {
    if (brouillon === null) return;
    // Validation par le contrat partagé — le même que celui de l'api et, demain,
    // du connecteur : ce que l'écran accepte est ce que la capture appliquera.
    const valide = parseRecordingPolicy(brouillon);
    if (!valide.ok) {
      setErreurs(valide.errors);
      return;
    }
    setEnvoi(true);
    setErreurs([]);
    try {
      const enregistre = await api.enregistrerBrouillon(valide.value);
      setBrouillon(enregistre.document);
      setMessage(
        'Brouillon enregistré. Il n’a aucun effet sur la capture tant qu’il n’est pas publié.',
      );
      await charger();
    } catch (e) {
      setErreurs([e instanceof ApiError ? e.message : 'Enregistrement impossible.']);
    } finally {
      setEnvoi(false);
    }
  }

  async function publier(): Promise<void> {
    setEnvoi(true);
    setErreurs([]);
    try {
      const publiee = await api.publierPolitique(note);
      setMessage(`Version ${publiee.version} publiée : elle s’applique désormais.`);
      setNote('');
      await charger();
    } catch (e) {
      setErreurs([e instanceof ApiError ? e.message : 'Publication impossible.']);
    } finally {
      setEnvoi(false);
    }
  }

  if (chargement) return <p className="text-sm text-ardoise-600">Chargement des politiques…</p>;

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-lg font-semibold tracking-tight">Politiques d’enregistrement</h1>
        <p className="mt-1 text-sm text-ardoise-600">
          Ce que la capture doit enregistrer, et ce qu’elle doit laisser passer. Chaque appel non
          enregistré sera motivé par la version qui s’appliquait.
        </p>
      </header>

      {message !== null && (
        <p className="rounded border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
          {message}
        </p>
      )}
      {erreurs.length > 0 && (
        <ul
          role="alert"
          className="space-y-1 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800"
        >
          {erreurs.map((erreur) => (
            <li key={erreur}>{erreur}</li>
          ))}
        </ul>
      )}

      <section aria-labelledby="en-vigueur">
        <h2 id="en-vigueur" className="mb-2 text-sm font-semibold">
          En vigueur
        </h2>
        {enVigueur === null ? (
          <p className="rounded border border-ardoise-200 bg-white p-4 text-sm text-ardoise-600">
            Aucune politique publiée : <strong>tous les appels sont enregistrés</strong>. C’est le
            défaut du produit — ne pas enregistrer doit résulter d’une décision écrite.
          </p>
        ) : (
          <div className="rounded border border-ardoise-200 bg-white p-4 text-sm">
            <p>
              <span className="font-medium">Version {enVigueur.version}</span> — publiée le{' '}
              {formatHorodatage(enVigueur.publishedAt ?? enVigueur.createdAt)} par{' '}
              {enVigueur.publishedByEmail}
            </p>
            {enVigueur.note !== null && (
              <p className="mt-1 text-ardoise-600">« {enVigueur.note} »</p>
            )}
            <p className="mt-2 text-ardoise-600">
              Par défaut : {enVigueur.resume.parDefaut} · {enVigueur.resume.regles} règle(s) ·{' '}
              {enVigueur.resume.exclusions} exclusion(s) · {enVigueur.resume.listes} liste(s)
            </p>
            <p className="mt-1 break-all font-mono text-xs text-ardoise-500">
              empreinte {enVigueur.sha256}
            </p>
          </div>
        )}
      </section>

      {peutGerer && (
        <section aria-labelledby="brouillon">
          <div className="mb-2 flex items-center justify-between">
            <h2 id="brouillon" className="text-sm font-semibold">
              Brouillon
            </h2>
            {brouillon === null && (
              <button
                type="button"
                className="rounded border border-ardoise-300 px-3 py-1 text-sm hover:bg-ardoise-50"
                onClick={() => setBrouillon(enVigueur?.document ?? politiqueParDefaut())}
              >
                {enVigueur === null ? 'Commencer une politique' : 'Partir de la version en vigueur'}
              </button>
            )}
          </div>

          {brouillon !== null && (
            <div className="space-y-4">
              <EditeurPolitique document={brouillon} onChange={setBrouillon} />

              <div className="rounded border border-ardoise-200 bg-white p-4">
                <label className="mb-1 block text-xs font-medium text-ardoise-700" htmlFor="note">
                  Ce que cette version change, et pourquoi
                </label>
                <input
                  id="note"
                  className="w-full rounded border border-ardoise-300 px-2 py-1 text-sm"
                  placeholder="Dix caractères au moins : un contrôleur lira cette phrase"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                />
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    disabled={envoi}
                    className="rounded border border-ardoise-300 px-3 py-1 text-sm hover:bg-ardoise-50 disabled:opacity-60"
                    onClick={() => void enregistrer()}
                  >
                    Enregistrer le brouillon
                  </button>
                  <button
                    type="button"
                    disabled={envoi || note.trim().length < 10}
                    className="rounded bg-accent-600 px-3 py-1 text-sm font-medium text-white hover:bg-accent-700 disabled:opacity-60"
                    onClick={() => void publier()}
                  >
                    Publier
                  </button>
                  <button
                    type="button"
                    disabled={envoi}
                    className="rounded border border-ardoise-300 px-3 py-1 text-sm text-red-700 hover:bg-red-50 disabled:opacity-60"
                    onClick={() => {
                      void api
                        .abandonnerBrouillon()
                        .catch(() => undefined)
                        .then(() => {
                          setBrouillon(null);
                          setMessage('Brouillon abandonné.');
                          return charger();
                        });
                    }}
                  >
                    Abandonner
                  </button>
                </div>
                <p className="mt-2 text-xs text-ardoise-500">
                  Une version publiée ne se modifie plus : on en publie une nouvelle. C’est ce qui
                  permet de dire, plus tard, quelle politique s’appliquait à une date donnée.
                </p>
              </div>
            </div>
          )}
        </section>
      )}

      <section aria-labelledby="historique">
        <h2 id="historique" className="mb-2 text-sm font-semibold">
          Historique
        </h2>
        {versions.length === 0 ? (
          <p className="text-sm text-ardoise-600">Aucune version enregistrée.</p>
        ) : (
          <table className="w-full border border-ardoise-200 bg-white text-sm">
            <thead className="bg-ardoise-50 text-left text-xs uppercase tracking-wide text-ardoise-600">
              <tr>
                <th className="px-3 py-2 font-medium">Version</th>
                <th className="px-3 py-2 font-medium">État</th>
                <th className="px-3 py-2 font-medium">Publiée le</th>
                <th className="px-3 py-2 font-medium">Par</th>
                <th className="px-3 py-2 font-medium">Note</th>
                <th className="px-3 py-2 font-medium">Contenu</th>
              </tr>
            </thead>
            <tbody>
              {versions.map((version) => (
                <tr key={version.id} className="border-t border-ardoise-100">
                  <td className="px-3 py-2 tabular-nums">{version.version}</td>
                  <td className="px-3 py-2">
                    {version.status === 'published' ? 'publiée' : 'brouillon'}
                  </td>
                  <td className="px-3 py-2">
                    {version.publishedAt === null ? '—' : formatHorodatage(version.publishedAt)}
                  </td>
                  <td className="px-3 py-2">{version.publishedByEmail ?? '—'}</td>
                  <td className="px-3 py-2 text-ardoise-600">{version.note ?? '—'}</td>
                  <td className="px-3 py-2 text-ardoise-600">
                    {version.resume.parDefaut} · {version.resume.regles} règle(s) ·{' '}
                    {version.resume.exclusions} exclusion(s)
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
