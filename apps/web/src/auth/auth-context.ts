import { createContext, useContext } from 'react';
import type { ProfileResponse } from '@voxecho/shared';

export interface EtatAuth {
  profil: ProfileResponse | null;
  chargement: boolean;
  connexion: (email: string, motDePasse: string) => Promise<void>;
  deconnexion: () => Promise<void>;
  /**
   * Renouvelle le mot de passe et remplace les jetons : le drapeau « à
   * renouveler » voyage dans le jeton, et sans cela le compte resterait bloqué
   * jusqu'à son expiration (§9.26).
   */
  changerMotDePasse: (ancien: string, nouveau: string) => Promise<void>;
}

export const AuthContext = createContext<EtatAuth | null>(null);

export function useAuth(): EtatAuth {
  const contexte = useContext(AuthContext);
  if (!contexte) {
    throw new Error('useAuth doit être utilisé à l’intérieur de AuthProvider.');
  }
  return contexte;
}
