import { useState, type FormEvent } from 'react';
import { ApiError } from '../api/client';
import { useAuth } from '../auth/auth-context';

const CHAMP =
  'w-full rounded border border-ardoise-300 px-2 py-1.5 text-sm ' +
  'focus:border-accent-600 focus:outline-none';

/**
 * Renouvellement d'un mot de passe provisoire — CLAUDE.md §9.26.
 *
 * Seul écran atteignable tant que le mot de passe n'a pas été changé. L'api
 * refuse de toute façon le reste : ce que le portail apporte ici, c'est de ne
 * pas laisser l'utilisateur devant une succession de refus.
 */
export function MotDePassePage() {
  const { profil, changerMotDePasse, deconnexion } = useAuth();
  const [ancien, setAncien] = useState('');
  const [nouveau, setNouveau] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [erreurs, setErreurs] = useState<string[]>([]);
  const [envoi, setEnvoi] = useState(false);

  async function soumettre(evenement: FormEvent<HTMLFormElement>): Promise<void> {
    evenement.preventDefault();
    setErreurs([]);
    if (nouveau !== confirmation) {
      setErreurs(['Les deux saisies diffèrent.']);
      return;
    }
    setEnvoi(true);
    try {
      await changerMotDePasse(ancien, nouveau);
    } catch (e) {
      setErreurs(
        (e instanceof ApiError ? e.details : undefined) ?? [
          e instanceof ApiError ? e.message : 'Le service est momentanément indisponible.',
        ],
      );
    } finally {
      setEnvoi(false);
    }
  }

  return (
    <main className="flex min-h-full items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm">
        <h1 className="text-xl font-semibold tracking-tight">Renouveler le mot de passe</h1>
        <p className="mt-2 text-sm text-ardoise-600">
          Mot de passe provisoire à remplacer avant d’accéder au portail.
        </p>

        <form
          onSubmit={soumettre}
          noValidate
          className="mt-6 rounded border border-ardoise-200 bg-white p-6"
        >
          <div className="mb-4">
            <label htmlFor="ancien" className="mb-1 block text-sm font-medium">
              Mot de passe actuel
            </label>
            <input
              id="ancien"
              type="password"
              autoComplete="current-password"
              required
              className={CHAMP}
              value={ancien}
              onChange={(e) => setAncien(e.target.value)}
            />
          </div>
          <div className="mb-4">
            <label htmlFor="nouveau" className="mb-1 block text-sm font-medium">
              Nouveau mot de passe
            </label>
            <input
              id="nouveau"
              type="password"
              autoComplete="new-password"
              required
              className={CHAMP}
              value={nouveau}
              onChange={(e) => setNouveau(e.target.value)}
            />
          </div>
          <div className="mb-6">
            <label htmlFor="confirmation" className="mb-1 block text-sm font-medium">
              Confirmation
            </label>
            <input
              id="confirmation"
              type="password"
              autoComplete="new-password"
              required
              className={CHAMP}
              value={confirmation}
              onChange={(e) => setConfirmation(e.target.value)}
            />
          </div>

          {erreurs.length > 0 && (
            <ul
              role="alert"
              className="mb-4 space-y-1 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800"
            >
              {erreurs.map((erreur) => (
                <li key={erreur}>{erreur}</li>
              ))}
            </ul>
          )}

          <button
            type="submit"
            disabled={envoi}
            className="w-full rounded bg-accent-600 px-3 py-2 text-sm font-medium text-white hover:bg-accent-700 disabled:opacity-60"
          >
            {envoi ? 'Enregistrement…' : 'Enregistrer'}
          </button>
        </form>

        <button
          type="button"
          onClick={() => void deconnexion()}
          className="mt-4 text-xs text-ardoise-500 hover:text-ardoise-800"
        >
          Se déconnecter ({profil?.email})
        </button>
      </div>
    </main>
  );
}
