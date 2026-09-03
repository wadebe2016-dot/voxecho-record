import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildWavPcm,
  INGEST_SAMPLE_RATE,
  parseIngestMetadata,
  parseRadical,
  readWavHeader,
} from '@voxecho/shared';

const SCRIPT = join(__dirname, '..', 'post-enregistrement.sh');

/**
 * Script post-enregistrement FreeSWITCH — CLAUDE.md §7 (S5) et §9.17.
 *
 * Ce que ces tests protègent : le §7 promet qu'au branchement réel, **aucun
 * changement ne sera nécessaire dans `apps/`**. Cette promesse ne tient que si
 * ce que dépose la capture est exactement ce que le portail attend. Le dépôt
 * est donc relu par les validateurs du contrat eux-mêmes — `parseRadical`,
 * `parseIngestMetadata`, `readWavHeader` — ceux-là mêmes qu'appelle
 * l'ingestion, comme on l'a fait pour le simulateur au S2.
 *
 * L'autre moitié du travail est de refuser : un dépôt mal formé partirait en
 * quarantaine avec un événement d'audit et un fichier à reprendre à la main.
 * Mieux vaut échouer ici, bruyamment, pendant que l'appel est encore frais.
 */
describe('script post-enregistrement', () => {
  let racine: string;
  let ingestDir: string;
  let enregistrements: string;

  const APPEL = {
    locataire: 'banque-cemac',
    refci: '16778001',
    poste: '1001',
    correspondant: '699112233',
    sens: 'outbound',
    debut: '2026-09-01T14:30:12+01:00',
    duree: 3,
  };

  /** Un WAV comme FreeSWITCH en produit : PCM, 8 kHz, mono. */
  function enregistrer(nom: string, secondes: number, options: { taux?: number } = {}): string {
    const taux = options.taux ?? INGEST_SAMPLE_RATE;
    const chemin = join(enregistrements, nom);
    writeFileSync(
      chemin,
      buildWavPcm({ samples: new Int16Array(taux * secondes), sampleRate: taux }),
    );
    return chemin;
  }

  function lancer(args: string[]): { code: number; sortie: string } {
    try {
      const sortie = execFileSync('bash', [SCRIPT, ...args], { encoding: 'utf8' });
      return { code: 0, sortie };
    } catch (erreur) {
      const echec = erreur as { status: number; stderr: string; stdout: string };
      return { code: echec.status, sortie: `${echec.stdout}${echec.stderr}` };
    }
  }

  function deposer(
    fichier: string,
    surcharges: Record<string, string> = {},
  ): { code: number; sortie: string } {
    const base: Record<string, string> = {
      '--fichier': fichier,
      '--locataire': APPEL.locataire,
      '--refci': APPEL.refci,
      '--poste': APPEL.poste,
      '--correspondant': APPEL.correspondant,
      '--sens': APPEL.sens,
      '--debut': APPEL.debut,
      '--duree': String(APPEL.duree),
      '--ingest-dir': ingestDir,
      ...surcharges,
    };
    return lancer(
      Object.entries(base).flatMap(([option, valeur]) =>
        // Un drapeau se passe seul : `--simulation ""` serait un argument vide.
        valeur === '' ? [option] : [option, valeur],
      ),
    );
  }

  beforeEach(() => {
    racine = mkdtempSync(join(tmpdir(), 'voxecho-fs-'));
    ingestDir = join(racine, 'ingest');
    enregistrements = join(racine, 'recordings');
    mkdirSync(ingestDir, { recursive: true });
    mkdirSync(enregistrements, { recursive: true });
  });

  afterEach(() => {
    rmSync(racine, { recursive: true, force: true });
  });

  describe('ce qu’il dépose', () => {
    it('écrit une paire que les validateurs du contrat acceptent', () => {
      const resultat = deposer(enregistrer('appel.wav', APPEL.duree));
      expect(resultat.code).toBe(0);

      const depot = join(ingestDir, APPEL.locataire);
      const fichiers = readdirSync(depot).sort();
      expect(fichiers).toEqual([
        '20260901-143012_16778001_1001_699112233.json',
        '20260901-143012_16778001_1001_699112233.wav',
      ]);

      // Le radical, tel que le lira l'ingestion.
      const radical = parseRadical('20260901-143012_16778001_1001_699112233');
      expect(radical).toMatchObject({
        date: '20260901',
        time: '143012',
        refci: APPEL.refci,
        near: APPEL.poste,
        far: APPEL.correspondant,
      });

      // Les métadonnées, relues par le validateur de l'api.
      const brut = readFileSync(join(depot, `${fichiers[1]?.replace('.wav', '')}.json`), 'utf8');
      const meta = parseIngestMetadata(JSON.parse(brut));
      expect(meta.ok).toBe(true);
      if (meta.ok) {
        expect(meta.value).toMatchObject({
          schema: 1,
          refci: APPEL.refci,
          near: APPEL.poste,
          far: APPEL.correspondant,
          direction: 'outbound',
          startedAt: APPEL.debut,
          durationSec: APPEL.duree,
          source: 'cucm-bib',
        });
        // Catégorie non déclarée : le producteur reste conforme (§9.10).
        expect(meta.value.category).toBeUndefined();
      }

      // Et l'audio, relu par le lecteur d'en-tête de l'ingestion.
      const wav = readFileSync(join(depot, fichiers[1] as string));
      const entete = readWavHeader(wav, wav.byteLength);
      expect(entete.ok).toBe(true);
      if (entete.ok) {
        expect(entete.value.sampleRate).toBe(INGEST_SAMPLE_RATE);
        expect(Math.round(entete.value.durationSec)).toBe(APPEL.duree);
      }
    });

    it('porte la catégorie d’opération quand elle est déclarée', () => {
      deposer(enregistrer('appel.wav', APPEL.duree), { '--categorie': 'confirmation_cheque' });

      const depot = join(ingestDir, APPEL.locataire);
      const json = readdirSync(depot).find((nom) => nom.endsWith('.json')) as string;
      const meta = parseIngestMetadata(JSON.parse(readFileSync(join(depot, json), 'utf8')));
      expect(meta.ok).toBe(true);
      if (meta.ok) expect(meta.value.category).toBe('confirmation_cheque');
    });

    it('ne laisse aucun fichier de travail sous surveillance', () => {
      const source = enregistrer('appel.wav', APPEL.duree);
      deposer(source);

      // Le portail met en quarantaine tout ce qui n'est ni .wav ni .json : un
      // fichier temporaire déposé ici produirait un incident à chaque appel.
      const depot = join(ingestDir, APPEL.locataire);
      for (const nom of readdirSync(depot)) {
        expect(nom).toMatch(/\.(wav|json)$/);
      }
      expect(readdirSync(ingestDir)).toEqual([APPEL.locataire]);
      // Le wav d'origine est consommé : FreeSWITCH n'a pas à faire le ménage.
      expect(() => readFileSync(source)).toThrow();
    });

    it('laisse l’enregistrement en place avec --garder', () => {
      const source = enregistrer('appel.wav', APPEL.duree);
      deposer(source, { '--garder': '' });
      expect(readFileSync(source).byteLength).toBeGreaterThan(44);
    });

    it('ne dépose rien en simulation', () => {
      const resultat = deposer(enregistrer('appel.wav', APPEL.duree), { '--simulation': '' });
      expect(resultat.code).toBe(0);
      expect(resultat.sortie).toMatch(/déposerait/);
      expect(readdirSync(ingestDir)).toEqual([]);
    });
  });

  describe('ce qu’il refuse', () => {
    it('refuse un wav qui n’est pas à la fréquence du contrat', () => {
      const resultat = deposer(enregistrer('16k.wav', APPEL.duree, { taux: 16_000 }));
      expect(resultat.code).not.toBe(0);
      expect(resultat.sortie).toMatch(/8000 Hz/);
      expect(readdirSync(ingestDir)).toEqual([]);
    });

    it('refuse un enregistrement tronqué plutôt que de le déposer', () => {
      // Le portail confronte la durée annoncée à l'audio : autant le faire
      // ici, où l'on peut encore agir, plutôt qu'en quarantaine.
      const resultat = deposer(enregistrer('court.wav', 1), { '--duree': '600' });
      expect(resultat.code).not.toBe(0);
      expect(resultat.sortie).toMatch(/tronqué/);
    });

    it('refuse un horodatage sans fuseau', () => {
      const resultat = deposer(enregistrer('appel.wav', APPEL.duree), {
        '--debut': '2026-09-01T14:30:12',
      });
      expect(resultat.code).not.toBe(0);
      expect(resultat.sortie).toMatch(/fuseau/);
    });

    it('refuse un sens, une source ou une catégorie hors contrat', () => {
      const wav = () => enregistrer(`${Math.random()}.wav`, APPEL.duree);
      expect(deposer(wav(), { '--sens': 'sortant' }).sortie).toMatch(/outbound/);
      expect(deposer(wav(), { '--source': 'asterisk' }).sortie).toMatch(/cucm-bib/);
      // Une catégorie accentuée est une faute de frappe, pas une catégorie.
      expect(deposer(wav(), { '--categorie': 'confirmation_chèque' }).sortie).toMatch(/inconnue/);
      expect(readdirSync(ingestDir)).toEqual([]);
    });

    it('refuse un locataire qui ne peut pas être un nom de répertoire', () => {
      const wav = () => enregistrer(`${Math.random()}.wav`, APPEL.duree);
      expect(deposer(wav(), { '--locataire': '../ailleurs' }).code).not.toBe(0);
      expect(deposer(wav(), { '--locataire': 'Banque CEMAC' }).code).not.toBe(0);
      expect(readdirSync(ingestDir)).toEqual([]);
    });

    it('refuse d’écraser un dépôt qui attend encore son ingestion', () => {
      expect(deposer(enregistrer('un.wav', APPEL.duree)).code).toBe(0);
      const second = deposer(enregistrer('deux.wav', APPEL.duree));

      expect(second.code).not.toBe(0);
      expect(second.sortie).toMatch(/déjà présent/);
      // Le second enregistrement n'a pas été consommé : il reste à traiter.
      expect(readFileSync(join(enregistrements, 'deux.wav')).byteLength).toBeGreaterThan(44);
    });

    it('refuse une option inconnue plutôt que de l’ignorer', () => {
      // Un dialplan qui croit passer une information que le script ne lit pas
      // doit s'en apercevoir tout de suite.
      const resultat = deposer(enregistrer('appel.wav', APPEL.duree), { '--agent': 'jean' });
      expect(resultat.code).not.toBe(0);
      expect(resultat.sortie).toMatch(/option inconnue/);
    });

    it('refuse un fichier absent ou vide', () => {
      expect(deposer(join(enregistrements, 'jamais-ecrit.wav')).sortie).toMatch(/introuvable/);
      const vide = join(enregistrements, 'vide.wav');
      writeFileSync(vide, '');
      expect(deposer(vide).sortie).toMatch(/vide ou tronqué/);
    });
  });
});
