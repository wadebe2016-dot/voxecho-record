import { SetMetadata } from '@nestjs/common';

export const PUBLIC_KEY = 'voxecho:public';

/** Marque une route accessible sans jeton (connexion, sonde de vie). */
export const Public = () => SetMetadata(PUBLIC_KEY, true);
