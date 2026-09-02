import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PrismaClient } from '@prisma/client';
import { empreinteCleMaitre, sceller, TAILLE_CLE } from '../src/storage/coffre';
import { creerSauvegarde, nomDePrise } from '../src/backup/sauvegarde.service';
import { verifierSauvegarde } from '../src/backup/verification.service';
import { lireManifeste, NOM_DUMP, NOM_INVENTAIRE, NOM_MANIFESTE } from '../src/backup/manifeste';
import { parcourirInventaire } from '../src/backup/inventaire';
import { cibleDepuisUrl, pgDump, SIGNATURE_DUMP } from '../src/backup/pg-dump';
import { analyserArguments } from '../src/backup/arguments';
import { MAX_EXEMPLES } from '../src/backup/constat';
import { createTestPrisma, resetTestData, testDatabaseUrl } from './helpers/database';

/**
 * Sauvegarde et vérification de restauration — CLAUDE.md §9.14.
 *
 * Ce que ces tests protègent tient en une phrase : une sauvegarde ne vaut que
 * si l'on peut démontrer, avant d'en avoir besoin, qu'elle est complète et
 * qu'on détient la clé qui l'ouvre. Chaque cas casse donc une pièce de
 * l'ensemble et vérifie que la vérification le dit.
 */

const CLE = randomBytes(TAILLE_CLE);
const AUTRE_CLE = randomBytes(TAILLE_CLE);

/** Dump factice : les cas qui portent sur pg_dump lui-même sont à part. */
async function fauxDump(_cible: unknown, destination: string): Promise<void> {
  await writeFile(destination, Buffer.concat([SIGNATURE_DUMP, Buffer.from('-faux-dump')]));
}

describe('sauvegarde et vérification de restauration', () => {
  let prisma: PrismaClient;
  let racine: string;
  let storageDir: string;
  let backupDir: string;
  let tenantId: string;

  /** Une pièce rangée : la ligne en base et le fichier sur le disque. */
  async function ranger(options: {
    nom: string;
    secondes?: number;
    scellee?: boolean;
    purgee?: boolean;
    /** Le json du contrat §3, que l'ingestion range à côté de la preuve. */
    sansDeclaration?: boolean;
  }): Promise<{ id: string; chemin: string; declaration: string; clair: Buffer }> {
    const clair = randomBytes((options.secondes ?? 1) * 16_000);
    const sha256 = createHash('sha256').update(clair).digest('hex');
    const chemin = join(tenantId, '2026', '09', `${options.nom}.wav`);

    const enregistrement = await prisma.recording.create({
      data: {
        tenantId,
        refci: options.nom,
        near: '1001',
        far: '699112233',
        direction: 'outbound',
        startedAt: new Date('2026-09-01T13:30:12Z'),
        durationSec: options.secondes ?? 1,
        filePath: chemin,
        sha256,
        sizeBytes: BigInt(clair.length),
        source: 'simulator',
        status: options.purgee ? 'purged' : 'stored',
        encrypted: options.scellee ?? false,
        keyRef: options.scellee ? 'k-test' : null,
      },
      select: { id: true },
    });

    const absolu = join(storageDir, chemin);
    await mkdir(join(absolu, '..'), { recursive: true });
    if (!options.purgee) {
      await writeFile(
        absolu,
        options.scellee ? sceller(clair, CLE, enregistrement.id, 4096) : clair,
      );
    }
    // La purge ne détruit que la conversation : la déclaration du producteur
    // reste au stockage, comme la ligne reste en base (§9.7).
    const declaration = chemin.replace(/\.wav$/, '.json');
    if (!options.sansDeclaration) {
      await writeFile(join(storageDir, declaration), JSON.stringify({ schema: 1 }));
    }
    return { id: enregistrement.id, chemin, declaration, clair };
  }

  async function prendre(): ReturnType<typeof creerSauvegarde> {
    return creerSauvegarde({
      prisma,
      destination: backupDir,
      storageDir,
      databaseUrl: testDatabaseUrl(),
      cleMaitre: CLE,
      version: '0.1.0-test',
      dumper: fauxDump,
    });
  }

  beforeAll(async () => {
    prisma = createTestPrisma();
    await prisma.$connect();
    racine = join(process.env.STORAGE_DIR as string, '..', 'sauvegarde');
    storageDir = join(racine, 'storage');
    backupDir = join(racine, 'backups');
  });

  afterAll(async () => {
    await resetTestData(prisma);
    await prisma.$disconnect();
    await rm(racine, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await resetTestData(prisma);
    await rm(racine, { recursive: true, force: true });
    await mkdir(storageDir, { recursive: true });
    await mkdir(backupDir, { recursive: true });

    const locataire = await prisma.tenant.create({
      data: { name: 'Banque de démonstration', slug: 'demo' },
      select: { id: true },
    });
    tenantId = locataire.id;
  });

  it('décrit ce qu’elle contient, une ligne d’inventaire par pièce', async () => {
    await ranger({ nom: 'claire' });
    await ranger({ nom: 'scellee', scellee: true });
    await ranger({ nom: 'detruite', purgee: true });

    const { repertoire, manifeste, empreinte } = await prendre();

    expect(manifeste.stockage.pieces).toBe(3);
    expect(manifeste.stockage.scellees).toBe(1);
    expect(manifeste.stockage.enClair).toBe(1);
    expect(manifeste.stockage.purgees).toBe(1);
    expect(manifeste.stockage.cles).toEqual(['k-test']);
    expect(manifeste.locataires).toEqual([
      { id: tenantId, slug: 'demo', nom: 'Banque de démonstration', actif: true, pieces: 3 },
    ]);
    // La dernière migration appliquée : la restauration devra la retrouver.
    expect(manifeste.base.derniereMigration).toMatch(/^\d{14}_/);
    expect(manifeste.base.migrationsAppliquees).toBeGreaterThan(0);

    const lignes = [];
    for await (const ligne of parcourirInventaire(join(repertoire, NOM_INVENTAIRE))) {
      lignes.push(ligne);
    }
    expect(lignes).toHaveLength(3);
    expect(lignes.filter((ligne) => ligne.statut === 'purged')).toHaveLength(1);

    // Le manifeste se relit avec son propre schéma, et son empreinte est
    // celle du fichier écrit : c'est elle que l'exploitant consigne ailleurs.
    const brut = await readFile(join(repertoire, NOM_MANIFESTE), 'utf8');
    expect(lireManifeste(brut)).toEqual(manifeste);
    expect(createHash('sha256').update(brut).digest('hex')).toBe(empreinte);
  });

  it('ne contient jamais la clé maître, seulement de quoi la reconnaître', async () => {
    await ranger({ nom: 'scellee', scellee: true });
    const { repertoire, manifeste } = await prendre();

    expect(manifeste.cleMaitre.empreinte).toBe(empreinteCleMaitre(CLE));
    expect(manifeste.cleMaitre.note).toMatch(/n’est pas dans cette sauvegarde/);

    for (const nom of await readdir(repertoire)) {
      const contenu = await readFile(join(repertoire, nom));
      expect(contenu.includes(CLE)).toBe(false);
      expect(contenu.toString('utf8').includes(CLE.toString('base64'))).toBe(false);
    }
  });

  it('une prise fraîche se vérifie sans anomalie, stockage compris', async () => {
    const claire = await ranger({ nom: 'claire' });
    await ranger({ nom: 'scellee', scellee: true });
    await ranger({ nom: 'detruite', purgee: true });

    const prise = await prendre();
    const rapport = await verifierSauvegarde({
      repertoire: prise.repertoire,
      cleMaitre: CLE,
      empreinteAttendue: prise.empreinte,
      storageDir,
    });

    expect(rapport.anomalies).toEqual([]);
    expect(rapport.restaurable).toBe(true);
    expect(rapport.empreinteConsignee).toBe('concorde');
    expect(rapport.cleMaitre).toBe('concorde');
    expect(rapport.base.conforme).toBe(true);
    expect(rapport.inventaire.conforme).toBe(true);
    // Deux pièces attendues sur le disque : la purgée n'en est pas une.
    expect(rapport.stockage).toMatchObject({ attendues: 2, verifiees: 2, sceauxNonVerifies: 0 });
    expect(claire.clair.length).toBeGreaterThan(0);
  });

  it('refuse une clé maître qui n’est pas celle de la prise', async () => {
    await ranger({ nom: 'scellee', scellee: true });
    const prise = await prendre();

    const rapport = await verifierSauvegarde({
      repertoire: prise.repertoire,
      cleMaitre: AUTRE_CLE,
      storageDir,
    });

    expect(rapport.cleMaitre).toBe('diverge');
    expect(rapport.restaurable).toBe(false);
    expect(rapport.anomalies.join(' ')).toMatch(/n’est pas celle de cette sauvegarde/);
    // Une clé qui ne concorde pas n'est pas utilisée pour ouvrir les sceaux :
    // le rapport dit que l'intégrité n'a pas été vérifiée, il ne l'invente pas.
    expect(rapport.stockage?.sceauxNonVerifies).toBe(1);
    expect(rapport.stockage?.divergentes.total).toBe(0);
  });

  it('sans clé, dit que les sceaux n’ont pas été ouverts plutôt que de conclure', async () => {
    await ranger({ nom: 'scellee', scellee: true });
    const prise = await prendre();

    const rapport = await verifierSauvegarde({
      repertoire: prise.repertoire,
      cleMaitre: null,
      storageDir,
    });

    expect(rapport.cleMaitre).toBe('absente');
    expect(rapport.stockage).toMatchObject({ attendues: 1, verifiees: 0, sceauxNonVerifies: 1 });
    expect(rapport.restaurable).toBe(false);
  });

  it('constate qu’un manifeste a été retouché depuis la prise', async () => {
    await ranger({ nom: 'claire' });
    const prise = await prendre();

    const chemin = join(prise.repertoire, NOM_MANIFESTE);
    const manifeste = JSON.parse(await readFile(chemin, 'utf8')) as Record<string, unknown>;
    (manifeste.stockage as Record<string, unknown>).pieces = 999;
    await writeFile(chemin, `${JSON.stringify(manifeste, null, 2)}\n`, 'utf8');

    const rapport = await verifierSauvegarde({
      repertoire: prise.repertoire,
      cleMaitre: CLE,
      empreinteAttendue: prise.empreinte,
      storageDir,
    });

    expect(rapport.empreinteConsignee).toBe('diverge');
    expect(rapport.anomalies.join(' ')).toMatch(/modifiée depuis sa prise/);
  });

  it('constate un dump tronqué', async () => {
    await ranger({ nom: 'claire' });
    const prise = await prendre();
    await writeFile(join(prise.repertoire, NOM_DUMP), 'coupé net');

    const rapport = await verifierSauvegarde({ repertoire: prise.repertoire, cleMaitre: CLE });

    expect(rapport.base.conforme).toBe(false);
    expect(rapport.base.signature).toBe(false);
    expect(rapport.restaurable).toBe(false);
  });

  it('constate une sauvegarde amputée sans partir en erreur', async () => {
    await ranger({ nom: 'claire' });
    const prise = await prendre();
    await rm(join(prise.repertoire, NOM_DUMP));
    await rm(join(prise.repertoire, NOM_INVENTAIRE));

    const rapport = await verifierSauvegarde({
      repertoire: prise.repertoire,
      cleMaitre: CLE,
      storageDir,
    });

    expect(rapport.anomalies.join(' ')).toMatch(/dump de la base manque/);
    expect(rapport.anomalies.join(' ')).toMatch(/inventaire du stockage manque/);
    // Sans inventaire, aucune conclusion n'est tirée sur le stockage.
    expect(rapport.stockage).toBeNull();
    expect(rapport.restaurable).toBe(false);
  });

  it('constate une pièce absente, une pièce altérée et un fichier orphelin', async () => {
    const absente = await ranger({ nom: 'absente' });
    const alteree = await ranger({ nom: 'alteree' });
    const prise = await prendre();

    await rm(join(storageDir, absente.chemin));
    const chemin = join(storageDir, alteree.chemin);
    const contenu = await readFile(chemin);
    contenu[10] = (contenu[10] ?? 0) ^ 0xff;
    await writeFile(chemin, contenu);
    await writeFile(join(storageDir, tenantId, '2026', '09', 'intrus.wav'), 'venu d’ailleurs');

    const rapport = await verifierSauvegarde({
      repertoire: prise.repertoire,
      cleMaitre: CLE,
      storageDir,
    });

    expect(rapport.stockage?.manquantes).toMatchObject({ total: 1, exemples: [absente.chemin] });
    expect(rapport.stockage?.divergentes).toMatchObject({ total: 1, exemples: [alteree.chemin] });
    expect(rapport.stockage?.orphelins).toMatchObject({
      total: 1,
      exemples: [join(tenantId, '2026', '09', 'intrus.wav').split('\\').join('/')],
    });
    expect(rapport.restaurable).toBe(false);
  });

  it('compte toutes les anomalies même quand elle cesse de les énumérer', async () => {
    // Le rapport annonçait la longueur de sa liste d'exemples : vingt-cinq
    // pièces disparues se lisaient « 20 pièce(s) absente(s) », et un sinistre
    // passait pour un incident local.
    for (let numero = 0; numero < 25; numero += 1) {
      await ranger({ nom: `piece-${numero}` });
    }
    const prise = await prendre();
    await rm(join(storageDir, tenantId), { recursive: true });

    const rapport = await verifierSauvegarde({
      repertoire: prise.repertoire,
      cleMaitre: CLE,
      storageDir,
    });

    expect(rapport.stockage?.manquantes.total).toBe(25);
    expect(rapport.stockage?.manquantes.exemples).toHaveLength(MAX_EXEMPLES);
    expect(rapport.stockage?.manquantes.tronque).toBe(true);
    expect(rapport.anomalies.join(' ')).toMatch(/25 pièce\(s\) absente\(s\)/);
  });

  it('constate un fichier revenu à la place d’une pièce purgée', async () => {
    const detruite = await ranger({ nom: 'detruite', purgee: true });
    const prise = await prendre();

    const absolu = join(storageDir, detruite.chemin);
    await mkdir(join(absolu, '..'), { recursive: true });
    await writeFile(absolu, 'ressuscité');

    const rapport = await verifierSauvegarde({
      repertoire: prise.repertoire,
      cleMaitre: CLE,
      storageDir,
    });

    expect(rapport.stockage?.purgeesAvecFichier).toMatchObject({
      total: 1,
      exemples: [detruite.chemin],
    });
    // La déclaration d'origine reste au stockage après la purge : elle n'est
    // pas orpheline, c'est ce qui documente ce qui a été détruit.
    expect(rapport.stockage?.orphelins.total).toBe(0);
    expect(rapport.restaurable).toBe(false);
  });

  it('constate la disparition d’une déclaration d’origine', async () => {
    const piece = await ranger({ nom: 'sans-json', sansDeclaration: true });
    const prise = await prendre();

    const rapport = await verifierSauvegarde({
      repertoire: prise.repertoire,
      cleMaitre: CLE,
      storageDir,
    });

    expect(rapport.stockage?.declarationsAbsentes).toMatchObject({
      total: 1,
      exemples: [piece.declaration],
    });
    // Le wav, lui, est intact : la vérification distingue les deux pertes.
    expect(rapport.stockage?.verifiees).toBe(1);
    expect(rapport.restaurable).toBe(false);
  });

  it('une trame permutée dans un conteneur est une divergence, pas un silence', async () => {
    const piece = await ranger({ nom: 'scellee', secondes: 2, scellee: true });
    const prise = await prendre();

    // Deux trames de 4 Kio échangées : chacune reste authentique isolément,
    // seul le rang scellé dans les données authentifiées trahit l'échange.
    const chemin = join(storageDir, piece.chemin);
    const conteneur = await readFile(chemin);
    const tailleTrame = 4096 + 12 + 16;
    const debutA = 40;
    const debutB = 40 + tailleTrame;
    const a = Buffer.from(conteneur.subarray(debutA, debutB));
    const b = Buffer.from(conteneur.subarray(debutB, debutB + tailleTrame));
    b.copy(conteneur, debutA);
    a.copy(conteneur, debutB);
    await writeFile(chemin, conteneur);

    const rapport = await verifierSauvegarde({
      repertoire: prise.repertoire,
      cleMaitre: CLE,
      storageDir,
    });

    expect(rapport.stockage?.divergentes.total).toBe(1);
    expect(rapport.stockage?.verifiees).toBe(0);
  });

  it('nomme les prises dans l’ordre où elles ont été faites', () => {
    expect(nomDePrise(new Date('2026-09-02T08:05:03Z'))).toBe('20260902-080503Z');
    expect(
      nomDePrise(new Date('2026-09-02T08:05:03Z')) < nomDePrise(new Date('2026-09-02T09:00:00Z')),
    ).toBe(true);
  });

  it('ne prend pas la valeur d’une option pour un répertoire, et refuse une option inconnue', () => {
    // Constaté à l'usage : `--empreinte <sha256>` faisait chercher la
    // sauvegarde dans un répertoire nommé d'après l'empreinte.
    const lus = analyserArguments(
      ['--', '/var/backups/20260902-171212Z', '--empreinte', 'ab12', '--stockage'],
      ['--empreinte'],
      ['--stockage'],
    );
    expect(lus.positionnels).toEqual(['/var/backups/20260902-171212Z']);
    expect(lus.valeurs.get('--empreinte')).toBe('ab12');
    expect(lus.drapeaux.has('--stockage')).toBe(true);

    // Une option mal orthographiée doit arrêter la commande : sinon elle
    // rendrait « aucune anomalie » sans avoir vérifié le stockage.
    expect(() => analyserArguments(['--stockages'], [], ['--stockage'])).toThrow(/Option inconnue/);
    expect(() => analyserArguments(['--empreinte'], ['--empreinte'], [])).toThrow(
      /attend une valeur/,
    );
  });

  it('sépare le schéma de l’URL de connexion : libpq refuse celle de Prisma', () => {
    expect(cibleDepuisUrl('postgresql://u:p@h:5432/db?schema=test_3&connection_limit=1')).toEqual({
      url: 'postgresql://u:p@h:5432/db',
      schema: 'test_3',
    });
    expect(cibleDepuisUrl('postgresql://u:p@h:5432/db').schema).toBe('public');
  });

  describe('pg_dump', () => {
    const disponible = (() => {
      try {
        execFileSync('pg_dump', ['--version'], { stdio: 'pipe' });
        return true;
      } catch {
        return false;
      }
    })();

    it(
      disponible
        ? 'produit une archive au format custom que la vérification reconnaît'
        : 'dit ce qu’il faut installer quand il est absent',
      async () => {
        await ranger({ nom: 'claire' });

        if (!disponible) {
          // Le manque est d'exploitation : le message doit désigner le paquet,
          // pas laisser lire une trace d'exécution.
          await expect(
            pgDump(cibleDepuisUrl(testDatabaseUrl()), join(backupDir, 'x.dump')),
          ).rejects.toThrow(/postgresql-client/);
          return;
        }

        const prise = await creerSauvegarde({
          prisma,
          destination: backupDir,
          storageDir,
          databaseUrl: testDatabaseUrl(),
          cleMaitre: CLE,
          version: '0.1.0-test',
        });
        const rapport = await verifierSauvegarde({
          repertoire: prise.repertoire,
          cleMaitre: CLE,
          empreinteAttendue: prise.empreinte,
          storageDir,
        });
        expect(rapport.base.signature).toBe(true);
        expect(rapport.anomalies).toEqual([]);
      },
      60_000,
    );
  });
});
