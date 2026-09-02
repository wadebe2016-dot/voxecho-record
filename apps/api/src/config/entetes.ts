import type { HelmetOptions } from 'helmet';

/**
 * En-têtes de sécurité de l'api — CLAUDE.md §9.16.
 *
 * L'api ne rend que du JSON, de l'audio et des archives : elle n'a ni page,
 * ni script, ni image à charger. Sa politique de contenu peut donc être la
 * plus stricte qui soit — `default-src 'none'` — au lieu des valeurs
 * généralistes de helmet, taillées pour un site qui affiche des pages.
 *
 * HSTS est le seul en-tête qu'il serait malhonnête d'émettre en clair : il
 * promet au navigateur que ce domaine se joint en HTTPS, et l'y contraint
 * ensuite pendant des mois. Tant qu'aucune terminaison TLS n'est déclarée,
 * on ne le promet pas.
 */
export function entetesDeSecurite(options: { derriereTls: boolean }): HelmetOptions {
  return {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        'default-src': ["'none'"],
        'frame-ancestors': ["'none'"],
        'base-uri': ["'none'"],
        'form-action': ["'none'"],
      },
    },
    // Une pièce probante n'a aucune raison d'être chargée par un autre site.
    crossOriginResourcePolicy: { policy: 'same-origin' },
    referrerPolicy: { policy: 'same-origin' },
    hsts: options.derriereTls ? { maxAge: 15_552_000, includeSubDomains: true } : false,
  };
}
