import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { racineDuDepot } from '../src/config/chemins';

const RACINE = racineDuDepot(__dirname);
const COMPOSE = join(RACINE, 'deploy', 'docker-compose.prod.yml');
const EXEMPLE = join(RACINE, 'deploy', '.env.prod.example');

/**
 * Composition de déploiement — CLAUDE.md §9.18.
 *
 * Ces vérifications existent parce que le défaut s'est produit : `.gitignore`
 * excluait `.env.*`, `deploy/.env.prod.example` n'a jamais été versionné, et
 * `git add -A` l'a ignoré sans un mot. Le manque ne s'est vu qu'au moment de le
 * lire sur l'instance, à l'étape 12 du runbook — c'est-à-dire au plus mauvais
 * endroit, chez celui qui déploie.
 *
 * Un fichier de déploiement absent ou incomplet ne casse aucun test tant qu'on
 * ne déploie pas : il faut donc le vérifier explicitement.
 */
describe('composition de déploiement', () => {
  const compose = readFileSync(COMPOSE, 'utf8');
  const exemple = readFileSync(EXEMPLE, 'utf8');

  /** Variables déclarées par le modèle d'environnement. */
  const declarees = new Set(
    exemple
      .split('\n')
      .filter((ligne) => ligne.includes('=') && !ligne.trimStart().startsWith('#'))
      .map((ligne) => (ligne.split('=', 1)[0] ?? '').trim()),
  );

  it('est suivie par git — modèle d’environnement compris', () => {
    // Le cas qui a échappé : un fichier présent sur le disque du développeur,
    // absent du dépôt, et personne pour s'en apercevoir avant l'instance.
    const suivis = execFileSync('git', ['ls-files', 'deploy/'], {
      cwd: RACINE,
      encoding: 'utf8',
    }).split('\n');

    for (const fichier of [
      'deploy/.env.prod.example',
      'deploy/docker-compose.prod.yml',
      'deploy/Caddyfile',
      'deploy/RUNBOOK.md',
    ]) {
      expect(suivis).toContain(fichier);
    }
  });

  it('déclare dans le modèle toutes les variables que la composition attend', () => {
    const attendues = new Set(
      [...compose.matchAll(/\$\{([A-Z0-9_]+)/g)].map((trouve) => trouve[1] as string),
    );
    const manquantes = [...attendues].filter((variable) => !declarees.has(variable)).sort();

    // Une variable oubliée dans le modèle donne un conteneur qui démarre avec
    // une valeur vide, ce qui se remarque bien plus tard que la lecture du
    // fichier — parfois seulement quand une pièce ne se déchiffre plus.
    expect(manquantes).toEqual([]);
  });

  it('ne contient aucun secret : le modèle se lit, il ne se copie pas tel quel', () => {
    const secrets = [
      'JWT_ACCESS_SECRET',
      'JWT_REFRESH_SECRET',
      'STORAGE_MASTER_KEY',
      'POSTGRES_PASSWORD',
    ];
    for (const secret of secrets) {
      const ligne = exemple.split('\n').find((l) => l.startsWith(`${secret}=`));
      expect(ligne).toBeDefined();
      // Valeur vide attendue : c'est `openssl rand` qui la remplit sur
      // l'instance, jamais le dépôt (§2, « pas de secret en dur »).
      expect(ligne?.trim()).toBe(`${secret}=`);
    }
  });

  it('n’expose que Caddy : ni la base ni l’api ne publient de port', () => {
    // En développement, la base publie 5432 pour l'outillage. Sur une instance
    // joignable depuis l'internet, seuls 80 et 443 doivent l'être.
    const ports = [...compose.matchAll(/^\s+- '(\d+):\d+'/gm)].map((t) => t[1]);
    expect(ports.sort()).toEqual(['443', '80']);
  });
});
