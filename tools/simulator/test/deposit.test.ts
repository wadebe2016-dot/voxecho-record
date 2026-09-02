import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  INGEST_DURATION_TOLERANCE_SEC,
  INGEST_SAMPLE_RATE,
  parseIngestMetadata,
  readWavHeader,
} from '@voxecho/shared';
import { deposerAppel } from '../src/deposit';
import { creerAlea } from '../src/random';
import { simuler } from '../src/simulate';
import { parseOptions, type Options } from '../src/options';

/**
 * Le dépôt est vérifié comme l'ingestion le vérifiera : mêmes lecteurs,
 * mêmes tolérances. Un simulateur qui produirait des fichiers que l'api
 * refuse ne servirait à rien, et un simulateur incapable de produire une
 * avarie ne prouverait pas la quarantaine.
 */
describe('dépôt d’un appel simulé', () => {
  let ingestDir: string;

  beforeEach(async () => {
    ingestDir = await mkdtemp(join(tmpdir(), 'voxecho-simulateur-'));
  });

  afterEach(async () => {
    await rm(ingestDir, { recursive: true, force: true });
  });

  it('écrit la paire dans le sous-répertoire du locataire', async () => {
    const depot = await deposerAppel({ ingestDir, slug: 'banque-cemac', alea: creerAlea(1) });

    const fichiers = await readdir(join(ingestDir, 'banque-cemac'));
    expect(fichiers.sort()).toEqual([`${depot.appel.radical}.json`, `${depot.appel.radical}.wav`]);
  });

  it('dépose un wav que le contrat §3 accepte', async () => {
    const depot = await deposerAppel({ ingestDir, slug: 'banque-cemac', alea: creerAlea(2) });

    const contenu = await readFile(depot.cheminWav);
    const taille = (await stat(depot.cheminWav)).size;
    const entete = readWavHeader(contenu, taille);

    expect(entete.ok).toBe(true);
    if (!entete.ok) return;
    expect(entete.value.sampleRate).toBe(INGEST_SAMPLE_RATE);
    expect(entete.value.channels).toBe(1);
    expect(entete.value.bitsPerSample).toBe(16);
  });

  it('dépose un audio dont la durée tient dans la tolérance de l’ingestion', async () => {
    for (let graine = 1; graine <= 20; graine += 1) {
      const depot = await deposerAppel({
        ingestDir,
        slug: 'banque-cemac',
        alea: creerAlea(graine),
      });
      const contenu = await readFile(depot.cheminWav);
      const entete = readWavHeader(contenu, contenu.byteLength);
      if (!entete.ok) throw new Error(entete.errors.join(', '));

      const ecart = Math.abs(entete.value.durationSec - depot.appel.metadata.durationSec);
      expect(ecart).toBeLessThanOrEqual(INGEST_DURATION_TOLERANCE_SEC);
    }
  });

  it('dépose un json que le contrat §3 valide', async () => {
    const depot = await deposerAppel({ ingestDir, slug: 'banque-cemac', alea: creerAlea(3) });

    const brut: unknown = JSON.parse(await readFile(depot.cheminJson, 'utf8'));
    expect(parseIngestMetadata(brut)).toMatchObject({ ok: true });
  });

  it('écrit le wav avant le json : le json ferme la paire', async () => {
    const depot = await deposerAppel({ ingestDir, slug: 'banque-cemac', alea: creerAlea(4) });

    const wav = await stat(depot.cheminWav);
    const json = await stat(depot.cheminJson);
    expect(json.mtimeMs).toBeGreaterThanOrEqual(wav.mtimeMs);
  });

  describe('avaries volontaires (--corrupt)', () => {
    it('produit un json que le contrat refuse', async () => {
      const depot = await deposerAppel({
        ingestDir,
        slug: 'banque-cemac',
        alea: creerAlea(5),
        avarie: 'json-malforme',
      });

      const brut = await readFile(depot.cheminJson, 'utf8');
      expect(() => JSON.parse(brut) as unknown).toThrow();
    });

    it('produit un wav tronqué que le lecteur d’en-tête démasque', async () => {
      const depot = await deposerAppel({
        ingestDir,
        slug: 'banque-cemac',
        alea: creerAlea(6),
        avarie: 'wav-tronque',
      });

      const contenu = await readFile(depot.cheminWav);
      const resultat = readWavHeader(contenu, contenu.byteLength);

      expect(resultat.ok).toBe(false);
      if (resultat.ok) return;
      expect(resultat.errors.join(' ')).toContain('tronqué');
    });
  });
});

describe('modes du simulateur', () => {
  let ingestDir: string;
  const silence = { depot: () => undefined };

  const options = (argv: string[]): Options => {
    const resultat = parseOptions([...argv, '--dir', ingestDir, '--seed', '7']);
    if (!resultat.ok) throw new Error(resultat.errors.join(' ; '));
    return resultat.value;
  };

  beforeEach(async () => {
    ingestDir = await mkdtemp(join(tmpdir(), 'voxecho-simulateur-'));
  });

  afterEach(async () => {
    await rm(ingestDir, { recursive: true, force: true });
  });

  it('--one dépose un appel', async () => {
    const depots = await simuler({ options: options(['--one']), journal: silence });
    expect(depots).toHaveLength(1);
  });

  it('--batch 50 dépose cinquante appels distincts : la sortie du jalon S2', async () => {
    const depots = await simuler({ options: options(['--batch', '50']), journal: silence });

    expect(depots).toHaveLength(50);
    const radicaux = new Set(depots.map((depot) => depot.appel.radical));
    expect(radicaux.size).toBe(50);

    const fichiers = await readdir(join(ingestDir, 'banque-cemac'));
    expect(fichiers).toHaveLength(100); // une paire par appel
  });

  it('--continuous tient sa cadence : 10/min vaut un appel toutes les six secondes', async () => {
    const attentes: number[] = [];
    let restants = 3;

    await simuler({
      options: options(['--continuous', '10/min']),
      journal: silence,
      attendre: async (ms) => {
        attentes.push(ms);
      },
      arret: () => (restants -= 1) < 0,
    });

    expect(attentes.every((ms) => ms === 6_000)).toBe(true);
  });

  it('répartit un lot entre les locataires demandés', async () => {
    const depots = await simuler({
      options: options(['--batch', '40', '--tenant', 'banque-cemac,mfi-b']),
      journal: silence,
    });

    const slugs = new Set(depots.map((depot) => depot.slug));
    expect(slugs).toEqual(new Set(['banque-cemac', 'mfi-b']));
  });

  it('alterne les avaries pour exercer les deux chemins de quarantaine', async () => {
    const depots = await simuler({
      options: options(['--batch', '6', '--corrupt']),
      journal: silence,
    });

    expect(depots.map((depot) => depot.avarie)).toEqual([
      'json-malforme',
      'wav-tronque',
      'json-malforme',
      'wav-tronque',
      'json-malforme',
      'wav-tronque',
    ]);
  });

  it('étale un lot sur plusieurs jours quand on le lui demande', async () => {
    const depots = await simuler({
      options: options(['--batch', '30', '--spread-days', '5']),
      journal: silence,
      maintenant: () => new Date('2026-09-02T10:00:00Z'),
    });

    const jours = new Set(depots.map((depot) => depot.appel.radical.slice(0, 8)));
    expect(jours.size).toBeGreaterThan(1);
  });
});
