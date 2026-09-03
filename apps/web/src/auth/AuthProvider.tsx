import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { ProfileResponse } from '@voxecho/shared';
import { ApiError, api, jetons } from '../api/client';
import { AuthContext, type EtatAuth } from './auth-context';

export function AuthProvider({ children }: { children: ReactNode }) {
  const [profil, setProfil] = useState<ProfileResponse | null>(null);
  const [chargement, setChargement] = useState(true);

  /** Restaure la session au chargement : jeton d'accès, sinon rafraîchissement. */
  useEffect(() => {
    let annule = false;

    async function restaurer(): Promise<void> {
      try {
        if (jetons.acces()) {
          const me = await api.profil();
          if (!annule) setProfil(me);
          return;
        }
        const refresh = jetons.rafraichissement();
        if (refresh) {
          jetons.enregistrer(await api.rafraichir(refresh));
          const me = await api.profil();
          if (!annule) setProfil(me);
        }
      } catch {
        jetons.effacer();
      } finally {
        if (!annule) setChargement(false);
      }
    }

    void restaurer();
    return () => {
      annule = true;
    };
  }, []);

  const connexion = useCallback(async (email: string, motDePasse: string) => {
    const paire = await api.connexion({ email, password: motDePasse });
    jetons.enregistrer(paire);
    try {
      setProfil(await api.profil());
    } catch (erreur) {
      jetons.effacer();
      throw erreur instanceof ApiError
        ? erreur
        : new ApiError(500, 'Le service est momentanément indisponible.');
    }
  }, []);

  const changerMotDePasse = useCallback(async (ancien: string, nouveau: string) => {
    jetons.enregistrer(await api.changerMotDePasse(ancien, nouveau));
    setProfil(await api.profil());
  }, []);

  const deconnexion = useCallback(async () => {
    try {
      await api.deconnexion(jetons.rafraichissement());
    } catch {
      // La session locale est fermée quoi qu'il arrive.
    } finally {
      jetons.effacer();
      setProfil(null);
    }
  }, []);

  const valeur = useMemo<EtatAuth>(
    () => ({ profil, chargement, connexion, deconnexion, changerMotDePasse }),
    [profil, chargement, connexion, deconnexion, changerMotDePasse],
  );

  return <AuthContext.Provider value={valeur}>{children}</AuthContext.Provider>;
}
