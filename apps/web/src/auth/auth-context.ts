import { createContext, useContext } from 'react';
import type { ProfileResponse } from '@voxecho/shared';

export interface EtatAuth {
  profil: ProfileResponse | null;
  chargement: boolean;
  connexion: (email: string, motDePasse: string) => Promise<void>;
  deconnexion: () => Promise<void>;
}

export const AuthContext = createContext<EtatAuth | null>(null);

export function useAuth(): EtatAuth {
  const contexte = useContext(AuthContext);
  if (!contexte) {
    throw new Error('useAuth doit être utilisé à l’intérieur de AuthProvider.');
  }
  return contexte;
}
