import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { racineDuDepot, resoudreCheminDeDonnees } from '../src/config/chemins';

/**
 * Les répertoires de données étaient résolus depuis le répertoire courant du
 * processus. La procédure du README — `pnpm dev` — lance l'api avec `apps/api`
 * pour répertoire courant : `./data/storage` désignait alors
 * `apps/api/data/storage`, et toute réécoute rendait 404 « fichier absent du
 * stockage » sur des preuves pourtant bien rangées à la racine. En livraison,
 * où les chemins sont absolus, rien ne paraissait.
 *
 * Le chemin d'une preuve ne doit pas dépendre de l'endroit d'où l'on a lancé
 * le processus.
 */
describe('résolution des répertoires de données', () => {
  /** Un faux dépôt : une racine marquée, un paquet deux niveaux plus bas. */
  async function fauxDepot(): Promise<{ racine: string; paquet: string }> {
    const racine = await mkdtemp(join(tmpdir(), 'voxecho-depot-'));
    await writeFile(join(racine, 'pnpm-workspace.yaml'), "packages:\n  - 'apps/*'\n");
    const paquet = join(racine, 'apps', 'api');
    await mkdir(paquet, { recursive: true });
    return { racine, paquet };
  }

  it('trouve la racine du dépôt depuis un paquet enfoui', async () => {
    const { racine, paquet } = await fauxDepot();
    expect(racineDuDepot(paquet)).toBe(resolve(racine));
  });

  it('rend le même répertoire de stockage, qu’on parte de la racine ou d’apps/api', async () => {
    const { racine, paquet } = await fauxDepot();

    const depuisLaRacine = resoudreCheminDeDonnees('./data/storage', racine);
    const depuisLePaquet = resoudreCheminDeDonnees('./data/storage', paquet);

    expect(depuisLePaquet).toBe(depuisLaRacine);
    expect(depuisLaRacine).toBe(resolve(racine, 'data/storage'));
    // Le piège d'origine, nommément : jamais sous apps/api.
    expect(depuisLePaquet).not.toContain(`${sep}apps${sep}api${sep}data`);
  });

  it('ne réinterprète pas un chemin absolu — c’est celui de la livraison', async () => {
    const { paquet } = await fauxDepot();
    expect(resoudreCheminDeDonnees('/data/storage', paquet)).toBe(resolve('/data/storage'));
  });

  it('s’en tient au point de départ hors d’un dépôt — l’image docker n’en est pas un', async () => {
    const isole = await mkdtemp(join(tmpdir(), 'voxecho-hors-depot-'));
    expect(racineDuDepot(isole)).toBe(resolve(isole));
    expect(resoudreCheminDeDonnees('data/storage', isole)).toBe(resolve(isole, 'data/storage'));
  });

  it('ancre les trois répertoires du contrat sur la même racine', async () => {
    const { racine, paquet } = await fauxDepot();
    for (const chemin of ['./data/ingest', './data/storage', './data/quarantine']) {
      expect(resoudreCheminDeDonnees(chemin, paquet)).toBe(resolve(racine, chemin));
    }
  });
});
