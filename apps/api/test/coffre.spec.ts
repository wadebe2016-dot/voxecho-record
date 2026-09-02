import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  deriverCle,
  estConteneur,
  fluxDeClair,
  lireEntete,
  ouvrir,
  sceller,
  tailleDuClair,
  TAILLE_CLE,
} from '../src/storage/coffre';

const CLE = randomBytes(TAILLE_CLE);
const APPEL = '11111111-1111-4111-8111-111111111111';
/** Petites trames : les cas limites arrivent vite et les tests restent rapides. */
const TRAME = 1024;

async function ecrire(
  conteneur: Buffer,
): Promise<{ chemin: string; nettoyer: () => Promise<void> }> {
  const racine = await mkdtemp(join(tmpdir(), 'voxecho-coffre-'));
  const chemin = join(racine, 'piece.bin');
  await writeFile(chemin, conteneur);
  return { chemin, nettoyer: () => rm(racine, { recursive: true, force: true }) };
}

async function plage(conteneur: Buffer, debut: number, fin: number): Promise<Buffer> {
  const { chemin, nettoyer } = await ecrire(conteneur);
  try {
    const morceaux: Buffer[] = [];
    for await (const morceau of fluxDeClair(chemin, CLE, APPEL, debut, fin)) {
      morceaux.push(morceau as Buffer);
    }
    return Buffer.concat(morceaux);
  } finally {
    await nettoyer();
  }
}

/**
 * Coffre — CLAUDE.md §8 et §9.13.
 *
 * Ce que ces tests protègent : le clair ressort bit pour bit, une plage
 * quelconque se lit sans tout déchiffrer, et **rien de modifié sur le disque
 * ne passe inaperçu**. C'est cette dernière propriété qui distingue un
 * chiffrement d'une simple obfuscation.
 */
describe('coffre de stockage', () => {
  describe('sceller et ouvrir', () => {
    it.each([
      ['un clair vide', 0],
      ['plus petit qu’une trame', 100],
      ['exactement une trame', TRAME],
      ['une trame et un octet', TRAME + 1],
      ['plusieurs trames pleines', TRAME * 4],
      ['plusieurs trames et un reste', TRAME * 4 + 37],
    ])('rend le clair bit pour bit : %s', (_libelle, taille) => {
      const clair = randomBytes(taille);
      const conteneur = sceller(clair, CLE, APPEL, TRAME);
      expect(ouvrir(conteneur, CLE, APPEL)).toEqual(clair);
    });

    it('produit un conteneur reconnaissable, qui n’est plus le clair', () => {
      const clair = Buffer.from('RIFF....WAVEfmt ');
      const conteneur = sceller(clair, CLE, APPEL, TRAME);

      expect(estConteneur(conteneur)).toBe(true);
      // Le wav ne doit plus être lisible : c'est tout l'objet de la manœuvre.
      expect(conteneur.subarray(0, 4).toString('latin1')).not.toBe('RIFF');
      expect(conteneur.includes(clair)).toBe(false);
    });

    it('reconnaît un fichier en clair comme n’étant pas un conteneur', () => {
      expect(estConteneur(Buffer.from('RIFF....WAVE'))).toBe(false);
      expect(estConteneur(Buffer.alloc(0))).toBe(false);
    });

    it('annonce la taille du clair sans le déchiffrer', async () => {
      const conteneur = sceller(randomBytes(TRAME * 3 + 11), CLE, APPEL, TRAME);
      const { chemin, nettoyer } = await ecrire(conteneur);
      try {
        expect(await tailleDuClair(chemin)).toBe(TRAME * 3 + 11);
      } finally {
        await nettoyer();
      }
    });

    it('ne réutilise jamais le même sel ni le même chiffré', () => {
      const clair = randomBytes(TRAME * 2);
      const premier = sceller(clair, CLE, APPEL, TRAME);
      const second = sceller(clair, CLE, APPEL, TRAME);

      expect(lireEntete(premier).sel).not.toEqual(lireEntete(second).sel);
      // Deux scellements du même clair ne doivent pas se ressembler : sinon
      // on lirait dans le stockage quels appels sont identiques.
      expect(premier.equals(second)).toBe(false);
    });
  });

  describe('lecture par plages', () => {
    const clair = randomBytes(TRAME * 5 + 123);
    const conteneur = sceller(clair, CLE, APPEL, TRAME);

    it.each([
      ['le fichier entier', 0, clair.length - 1],
      ['le tout début', 0, 9],
      ['la fin', clair.length - 50, clair.length - 1],
      ['à cheval sur deux trames', TRAME - 5, TRAME + 5],
      ['une trame entière', TRAME, TRAME * 2 - 1],
      ['un octet unique', TRAME * 3 + 7, TRAME * 3 + 7],
      ['plusieurs trames', TRAME, TRAME * 4 + 10],
    ])('rend exactement %s', async (_libelle, debut, fin) => {
      expect(await plage(conteneur, debut, fin)).toEqual(clair.subarray(debut, fin + 1));
    });

    it('ne rend rien pour une plage hors du clair', async () => {
      expect(await plage(conteneur, clair.length, clair.length + 10)).toHaveLength(0);
    });
  });

  describe('ce qui ne doit jamais passer', () => {
    const clair = randomBytes(TRAME * 3);
    const conteneur = sceller(clair, CLE, APPEL, TRAME);

    it('refuse une autre clé', () => {
      expect(() => ouvrir(conteneur, randomBytes(TAILLE_CLE), APPEL)).toThrow();
    });

    it('refuse la clé d’un autre enregistrement', () => {
      // L'identifiant entre dans la dérivation : une pièce ne s'ouvre pas au
      // nom d'un autre appel, même avec la bonne clé maître.
      expect(() => ouvrir(conteneur, CLE, '22222222-2222-4222-8222-222222222222')).toThrow();
    });

    it('détecte un octet modifié dans le chiffré', () => {
      const altere = Buffer.from(conteneur);
      altere.writeUInt8(altere.readUInt8(100) ^ 0x01, 100);
      expect(() => ouvrir(altere, CLE, APPEL)).toThrow();
    });

    it('détecte une trame déplacée dans le fichier', () => {
      // Sans l'indice de trame dans les données authentifiées, chaque trame
      // resterait authentique isolément et le fichier serait falsifiable par
      // simple permutation.
      const surDisque = 12 + TRAME + 16;
      const altere = Buffer.from(conteneur);
      const premiere = Buffer.from(altere.subarray(40, 40 + surDisque));
      const seconde = Buffer.from(altere.subarray(40 + surDisque, 40 + surDisque * 2));
      seconde.copy(altere, 40);
      premiere.copy(altere, 40 + surDisque);

      expect(() => ouvrir(altere, CLE, APPEL)).toThrow();
    });

    it('détecte une trame transplantée depuis un autre fichier', () => {
      const autre = sceller(randomBytes(TRAME * 3), CLE, APPEL, TRAME);
      const surDisque = 12 + TRAME + 16;
      const altere = Buffer.from(conteneur);
      autre.subarray(40, 40 + surDisque).copy(altere, 40);

      expect(() => ouvrir(altere, CLE, APPEL)).toThrow();
    });

    it('détecte un en-tête retouché', () => {
      const altere = Buffer.from(conteneur);
      // On annonce une trame plus courte : l'en-tête étant authentifié, la
      // première trame ouverte doit déjà refuser.
      altere.writeUInt32BE(TRAME / 2, 12);
      expect(() => ouvrir(altere, CLE, APPEL)).toThrow();
    });

    it('refuse un fichier qui n’est pas un conteneur', () => {
      // Assez long pour dépasser l'en-tête : c'est bien la magie qui doit
      // refuser, pas un contrôle de taille.
      const wav = Buffer.concat([Buffer.from('RIFF....WAVEfmt '), Buffer.alloc(64)]);
      expect(() => lireEntete(wav)).toThrow(/non reconnu/);
    });

    it('refuse un conteneur tronqué', async () => {
      const tronque = conteneur.subarray(0, conteneur.length - 32);
      const { chemin, nettoyer } = await ecrire(tronque);
      try {
        await expect(async () => {
          for await (const _ of fluxDeClair(chemin, CLE, APPEL, 0, clair.length - 1)) {
            // on ne consomme rien : c'est la lecture elle-même qui doit lever
          }
        }).rejects.toThrow(/tronqué|tronquée/);
      } finally {
        await nettoyer();
      }
    });

    it('refuse une clé maître de mauvaise taille', () => {
      expect(() => deriverCle(randomBytes(16), randomBytes(16), APPEL)).toThrow(/32 octets/);
    });
  });

  it('ne laisse pas le clair sur le disque après scellement', async () => {
    const clair = Buffer.from('conversation confidentielle du client');
    const conteneur = sceller(clair, CLE, APPEL, TRAME);
    const { chemin, nettoyer } = await ecrire(conteneur);
    try {
      const surDisque = await readFile(chemin);
      expect(surDisque.includes('confidentielle')).toBe(false);
    } finally {
      await nettoyer();
    }
  });
});
