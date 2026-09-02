import type { INestApplication } from '@nestjs/common';
import helmet from 'helmet';
import { entetesDeSecurite } from './entetes';
import { confianceProxy } from './proxies';

/**
 * Réglages de sécurité de la couche HTTP — CLAUDE.md §9.16.
 *
 * Rassemblés ici pour que l'application montée par les tests soit configurée
 * exactement comme celle que lance `main.ts` : une protection qui n'est
 * posée que dans le point d'entrée n'est jamais éprouvée.
 */
export function configurerSecuriteHttp(
  app: INestApplication,
  options: { trustedProxies: string; derriereTls: boolean },
): void {
  // L'adresse tracée au journal doit être celle du demandeur, pas celle du
  // relais — et seulement si ce relais a été déclaré.
  app.getHttpAdapter().getInstance().set('trust proxy', confianceProxy(options.trustedProxies));
  app.use(helmet(entetesDeSecurite({ derriereTls: options.derriereTls })));
}
