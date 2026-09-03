import { useCallback, useEffect, useState } from 'react';
import {
  ROLES,
  type Role,
  type TemporaryPasswordResponse,
  type UserSummary,
} from '@voxecho/shared';
import { ApiError, api } from '../api/client';
import { useAuth } from '../auth/auth-context';
import { Aide } from '../components/Aide';
import { formatHorodatage, libelleRole } from '../lib/format';

const CHAMP =
  'rounded border border-ardoise-300 bg-white px-2 py-1 text-sm ' +
  'focus:border-ardoise-500 focus:outline-none focus:ring-1 focus:ring-ardoise-500';

/**
 * Comptes du locataire — CLAUDE.md §9.26.
 *
 * Un compte ne se supprime pas, il se désactive. Le mot de passe provisoire
 * s'affiche une seule fois : cet écran est le seul endroit où il paraîtra.
 */
export function ComptesPage() {
  const { profil } = useAuth();
  const [comptes, setComptes] = useState<UserSummary[]>([]);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('AUDITOR');
  const [provisoire, setProvisoire] = useState<TemporaryPasswordResponse | null>(null);
  const [erreurs, setErreurs] = useState<string[]>([]);
  const [chargement, setChargement] = useState(true);
  const [envoi, setEnvoi] = useState(false);

  const charger = useCallback(async () => {
    setChargement(true);
    try {
      setComptes(await api.comptes());
    } catch (e) {
      setErreurs([
        e instanceof ApiError ? e.message : 'Le service est momentanément indisponible.',
      ]);
    } finally {
      setChargement(false);
    }
  }, []);

  useEffect(() => {
    void charger();
  }, [charger]);

  async function agir(action: () => Promise<unknown>): Promise<void> {
    setEnvoi(true);
    setErreurs([]);
    try {
      const resultat = await action();
      if (resultat !== null && typeof resultat === 'object' && 'motDePasseProvisoire' in resultat) {
        setProvisoire(resultat as TemporaryPasswordResponse);
      }
      await charger();
    } catch (e) {
      setErreurs(
        (e instanceof ApiError ? e.details : undefined) ?? [
          e instanceof ApiError ? e.message : 'Opération impossible.',
        ],
      );
    } finally {
      setEnvoi(false);
    }
  }

  if (chargement) return <p className="text-sm text-ardoise-600">Chargement des comptes…</p>;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-lg font-semibold tracking-tight">
          Comptes
          <Aide texte="Un compte ne se supprime pas : il se désactive. Le journal d’audit référence son auteur, et l’effacer effacerait le lien vers ce qu’il a écouté." />
        </h1>
      </header>

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

      {provisoire !== null && (
        <div
          data-testid="mot-de-passe-provisoire"
          className="rounded border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-900"
        >
          <p>
            Mot de passe provisoire de <strong>{provisoire.compte.email}</strong>, affiché une seule
            fois :
          </p>
          <p className="mt-1 font-mono text-base tracking-wider">
            {provisoire.motDePasseProvisoire}
          </p>
          <button
            type="button"
            className="mt-2 text-xs underline"
            onClick={() => setProvisoire(null)}
          >
            J’ai noté
          </button>
        </div>
      )}

      <section className="rounded border border-ardoise-200 bg-white p-4">
        <h2 className="mb-3 text-sm font-semibold">Créer un compte</h2>
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-64 flex-1">
            <label className="mb-1 block text-xs font-medium text-ardoise-700" htmlFor="email">
              Adresse électronique
            </label>
            <input
              id="email"
              type="email"
              className={`${CHAMP} w-full`}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-ardoise-700" htmlFor="role">
              Rôle
            </label>
            <select
              id="role"
              className={CHAMP}
              value={role}
              onChange={(e) => setRole(e.target.value as Role)}
            >
              {ROLES.map((valeur) => (
                <option key={valeur} value={valeur}>
                  {libelleRole(valeur)}
                </option>
              ))}
            </select>
          </div>
          <button
            type="button"
            disabled={envoi || email.trim() === ''}
            className="rounded bg-accent-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-accent-700 disabled:opacity-60"
            onClick={() =>
              void agir(async () => {
                const cree = await api.creerCompte(email.trim(), role);
                setEmail('');
                return cree;
              })
            }
          >
            Créer
          </button>
        </div>
      </section>

      <table className="w-full border border-ardoise-200 bg-white text-sm">
        <thead className="bg-ardoise-50 text-left text-xs uppercase tracking-wide text-ardoise-600">
          <tr>
            <th className="px-3 py-2 font-medium">Adresse</th>
            <th className="px-3 py-2 font-medium">Rôle</th>
            <th className="px-3 py-2 font-medium">État</th>
            <th className="px-3 py-2 font-medium">Dernière connexion</th>
            <th className="px-3 py-2 font-medium">Actions</th>
          </tr>
        </thead>
        <tbody>
          {comptes.map((compte) => {
            const soiMeme = compte.id === profil?.id;
            return (
              <tr key={compte.id} className="border-t border-ardoise-100">
                <td className="px-3 py-2">
                  {compte.email}
                  {compte.instanceAdmin && (
                    <span className="ml-2 rounded bg-ardoise-100 px-1.5 py-0.5 text-xs">
                      instance
                      <Aide texte="Administrateur de l’instance : il règle ce qui vaut pour tous les locataires. Ce privilège s’accorde en ligne de commande." />
                    </span>
                  )}
                </td>
                <td className="px-3 py-2">
                  <select
                    aria-label={`Rôle de ${compte.email}`}
                    className={CHAMP}
                    disabled={envoi || soiMeme}
                    value={compte.role}
                    onChange={(e) =>
                      void agir(() =>
                        api.modifierCompte(compte.id, { role: e.target.value as Role }),
                      )
                    }
                  >
                    {ROLES.map((valeur) => (
                      <option key={valeur} value={valeur}>
                        {libelleRole(valeur)}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="px-3 py-2">
                  {compte.active ? 'actif' : <span className="text-amber-700">désactivé</span>}
                  {compte.mustChangePassword && (
                    <span className="ml-2 text-xs text-ardoise-500">mot de passe à renouveler</span>
                  )}
                  {compte.lockedUntil !== null && (
                    <span className="ml-2 text-xs text-amber-700">verrouillé</span>
                  )}
                </td>
                <td className="px-3 py-2 text-ardoise-600">
                  {compte.lastLoginAt === null ? '—' : formatHorodatage(compte.lastLoginAt)}
                </td>
                <td className="px-3 py-2">
                  <div className="flex gap-3 text-xs">
                    <button
                      type="button"
                      disabled={envoi || soiMeme}
                      className="text-ardoise-700 underline disabled:no-underline disabled:opacity-40"
                      onClick={() =>
                        void agir(() => api.modifierCompte(compte.id, { active: !compte.active }))
                      }
                    >
                      {compte.active ? 'Désactiver' : 'Réactiver'}
                    </button>
                    <button
                      type="button"
                      disabled={envoi}
                      className="text-ardoise-700 underline disabled:no-underline disabled:opacity-40"
                      onClick={() => void agir(() => api.reinitialiserCompte(compte.id))}
                    >
                      Réinitialiser
                    </button>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
