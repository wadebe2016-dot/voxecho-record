import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError } from '../api/client';
import { useAuth } from '../auth/auth-context';

export function LoginPage() {
  const { connexion } = useAuth();
  const [email, setEmail] = useState('');
  const [motDePasse, setMotDePasse] = useState('');
  const [erreur, setErreur] = useState<string | null>(null);
  const [envoi, setEnvoi] = useState(false);
  const [evaluation, setEvaluation] = useState(false);

  // Une version d'évaluation doit le dire, et le dire avant qu'on s'y
  // connecte (§9.18, §9.21) : un visiteur qui voit des appels, des empreintes et un
  // journal d'audit n'a aucun moyen de savoir s'il regarde des conversations
  // simulées ou celles des clients d'une banque. L'appel échoue en silence si
  // l'api ne répond pas : l'écran de connexion doit rester utilisable.
  useEffect(() => {
    let vivant = true;
    void api
      .instance()
      .then((info) => {
        if (vivant) setEvaluation(info.evaluation);
      })
      .catch(() => undefined);
    return () => {
      vivant = false;
    };
  }, []);

  async function soumettre(evenement: FormEvent<HTMLFormElement>): Promise<void> {
    evenement.preventDefault();
    setErreur(null);
    setEnvoi(true);
    try {
      await connexion(email, motDePasse);
    } catch (e) {
      setErreur(e instanceof ApiError ? e.message : 'Le service est momentanément indisponible.');
    } finally {
      setEnvoi(false);
    }
  }

  return (
    <main className="flex min-h-full items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm">
        <header className="mb-8">
          <h1 className="text-xl font-semibold tracking-tight">VoxEcho Record</h1>
          {/* Ni éditeur ni ville : le produit se présente par ce qu'il fait, et
              cet écran est le premier que voit une DSI qui l'évalue (§9.20). */}
          <p className="mt-2 text-sm text-ardoise-600">
            Enregistrement d’appels de conformité. Accès réservé aux personnes habilitées ; chaque
            consultation est tracée.
          </p>
        </header>

        {evaluation && (
          <p
            data-testid="bandeau-evaluation"
            className="mb-6 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900"
          >
            <strong className="font-semibold">Version d’évaluation.</strong> Les appels présentés
            sont fabriqués&nbsp;: aucune conversation réelle de client n’y figure.
          </p>
        )}

        <form
          onSubmit={soumettre}
          noValidate
          className="rounded border border-ardoise-200 bg-white p-6"
        >
          <div className="mb-4">
            <label htmlFor="email" className="mb-1 block text-sm font-medium">
              Adresse électronique
            </label>
            <input
              id="email"
              name="email"
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full rounded border border-ardoise-200 px-3 py-2 text-sm focus:border-accent-600 focus:outline-none"
            />
          </div>

          <div className="mb-6">
            <label htmlFor="motDePasse" className="mb-1 block text-sm font-medium">
              Mot de passe
            </label>
            <input
              id="motDePasse"
              name="motDePasse"
              type="password"
              autoComplete="current-password"
              required
              value={motDePasse}
              onChange={(e) => setMotDePasse(e.target.value)}
              className="w-full rounded border border-ardoise-200 px-3 py-2 text-sm focus:border-accent-600 focus:outline-none"
            />
          </div>

          {erreur !== null && (
            <p
              role="alert"
              className="mb-4 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800"
            >
              {erreur}
            </p>
          )}

          <button
            type="submit"
            disabled={envoi}
            className="w-full rounded bg-accent-600 px-3 py-2 text-sm font-medium text-white hover:bg-accent-700 disabled:opacity-60"
          >
            {envoi ? 'Connexion…' : 'Se connecter'}
          </button>
        </form>

        <p className="mt-6 text-xs text-ardoise-400">
          Après plusieurs échecs, le compte est temporairement verrouillé.
        </p>
      </div>
    </main>
  );
}
