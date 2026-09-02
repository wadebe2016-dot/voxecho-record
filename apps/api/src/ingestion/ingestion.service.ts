import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Injectable, Logger } from '@nestjs/common';
import type { Source } from '@prisma/client';
import {
  INGEST_AUDIO_EXTENSION,
  INGEST_DURATION_TOLERANCE_SEC,
  INGEST_METADATA_EXTENSION,
  INGEST_SAMPLE_RATE,
  isTenantSlug,
  parseIngestMetadata,
  parseRadical,
  radicalOf,
  readWavHeader,
  storageRelativePath,
  type IngestMetadata,
} from '@voxecho/shared';
import { AuditService } from '../audit/audit.service';
import { resoudreCheminDeDonnees } from '../config/chemins';
import { AppConfig } from '../config/config.module';
import { PrismaService } from '../prisma/prisma.service';

/** Compte rendu d'un balayage, utilisé par les tests et par la journalisation. */
export interface IngestionReport {
  ingested: number;
  duplicates: number;
  quarantined: number;
  pending: number;
}

interface TenantRef {
  id: string;
  slug: string;
}

/** Octets lus en tête de wav : large de quoi couvrir des chunks annexes. */
const HEADER_BYTES = 4_096;

/**
 * Ingestion — contrat CLAUDE.md §3.
 *
 * Seul point d'entrée des enregistrements dans le portail. Le service ne
 * connaît rien de la capture : il ne lit que des fichiers déposés, et toute
 * anomalie se règle par la quarantaine, jamais par une suppression ni par une
 * correction silencieuse.
 */
@Injectable()
export class IngestionService {
  private readonly logger = new Logger(IngestionService.name);
  private readonly ingestDir: string;
  private readonly storageDir: string;
  private readonly quarantineDir: string;
  private readonly orphanMs: number;
  /** Un seul balayage à la fois : deux passes concurrentes se disputeraient les fichiers. */
  private enCours = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    config: AppConfig,
  ) {
    this.ingestDir = resoudreCheminDeDonnees(config.get('INGEST_DIR'));
    this.storageDir = resoudreCheminDeDonnees(config.get('STORAGE_DIR'));
    this.quarantineDir = resoudreCheminDeDonnees(config.get('QUARANTINE_DIR'));
    this.orphanMs = config.get('INGEST_ORPHAN_MIN') * 60_000;
  }

  /**
   * Balaie `INGEST_DIR` une fois et traite tout ce qui est complet. Ne lève
   * pas : une anomalie sur un appel ne doit pas empêcher d'ingérer les
   * suivants.
   */
  async scan(): Promise<IngestionReport> {
    const report: IngestionReport = { ingested: 0, duplicates: 0, quarantined: 0, pending: 0 };
    if (this.enCours) return report;
    this.enCours = true;
    try {
      await mkdir(this.ingestDir, { recursive: true });
      const tenants = await this.prisma.tenant.findMany({
        where: { active: true },
        select: { id: true, slug: true },
      });
      const parSlug = new Map(tenants.map((tenant) => [tenant.slug, tenant]));

      const entrees = await readdir(this.ingestDir, { withFileTypes: true });
      for (const entree of entrees) {
        if (entree.isDirectory()) {
          const tenant = isTenantSlug(entree.name) ? parSlug.get(entree.name) : undefined;
          if (tenant) {
            await this.scanTenant(tenant, join(this.ingestDir, entree.name), report);
          } else {
            // Contrat §3 : jamais de création implicite de locataire.
            await this.quarantineInconnu(
              join(this.ingestDir, entree.name),
              entree.name,
              report,
              `sous-répertoire « ${entree.name} » : aucun locataire actif de ce slug`,
            );
          }
        } else if (entree.isFile()) {
          await this.quarantineInconnu(
            join(this.ingestDir, entree.name),
            entree.name,
            report,
            `fichier déposé à la racine d'INGEST_DIR : le locataire n'est pas désigné`,
          );
        }
      }
    } catch (error) {
      this.logger.error(
        `Balayage de ${this.ingestDir} interrompu`,
        error instanceof Error ? error.stack : String(error),
      );
    } finally {
      this.enCours = false;
    }
    return report;
  }

  /** Traite le sous-répertoire d'un locataire actif. */
  private async scanTenant(tenant: TenantRef, dir: string, report: IngestionReport): Promise<void> {
    const fichiers = (await readdir(dir, { withFileTypes: true }))
      .filter((entree) => entree.isFile())
      .map((entree) => entree.name);

    // Regroupement par radical : le contrat garantit que les deux fichiers
    // d'un appel partagent le leur.
    const paires = new Map<string, { wav?: string; json?: string; autres: string[] }>();
    for (const nom of fichiers) {
      const radical = radicalOf(nom);
      const paire = paires.get(radical) ?? { autres: [] };
      if (nom.toLowerCase().endsWith(INGEST_AUDIO_EXTENSION)) paire.wav = nom;
      else if (nom.toLowerCase().endsWith(INGEST_METADATA_EXTENSION)) paire.json = nom;
      else paire.autres.push(nom);
      paires.set(radical, paire);
    }

    for (const [radical, paire] of paires) {
      for (const intrus of paire.autres) {
        await this.quarantine(tenant, dir, [intrus], report, [
          `extension inattendue : le contrat §3 ne dépose que .wav et .json`,
        ]);
      }

      if (paire.wav && paire.json) {
        await this.traiterPaire(tenant, dir, radical, paire.wav, paire.json, report);
      } else if (paire.json && !paire.wav) {
        // Le json arrive en dernier : sans wav, l'appel ne viendra plus.
        await this.quarantine(tenant, dir, [paire.json], report, ['wav manquant']);
      } else if (paire.wav && !paire.json) {
        const age = Date.now() - (await stat(join(dir, paire.wav))).mtimeMs;
        if (age > this.orphanMs) {
          await this.quarantine(tenant, dir, [paire.wav], report, [
            `json jamais déposé (wav inchangé depuis ${Math.round(age / 60_000)} min)`,
          ]);
        } else {
          report.pending += 1; // dépôt probablement en cours.
        }
      }
    }
  }

  /**
   * Vérifie puis range une paire complète. L'ordre est celui de la preuve :
   * on ne crée rien en base tant que le fichier n'a pas été lu, mesuré et
   * empreint.
   */
  private async traiterPaire(
    tenant: TenantRef,
    dir: string,
    radical: string,
    nomWav: string,
    nomJson: string,
    report: IngestionReport,
  ): Promise<void> {
    const cheminWav = join(dir, nomWav);
    const cheminJson = join(dir, nomJson);
    const fichiers = [nomWav, nomJson];

    if (!parseRadical(radical)) {
      await this.quarantine(tenant, dir, fichiers, report, [
        `nom hors contrat : « ${radical} » ne suit pas <yyyymmdd>-<HHMMSS>_<refci>_<near>_<far>`,
      ]);
      return;
    }

    let brut: unknown;
    try {
      brut = JSON.parse(await readFile(cheminJson, 'utf8'));
    } catch (error) {
      await this.quarantine(tenant, dir, fichiers, report, [
        `json illisible : ${error instanceof Error ? error.message : String(error)}`,
      ]);
      return;
    }

    const metadonnees = parseIngestMetadata(brut);
    if (!metadonnees.ok) {
      await this.quarantine(tenant, dir, fichiers, report, metadonnees.errors);
      return;
    }
    const meta = metadonnees.value;

    const incoherences = coherenceNomMetadonnees(radical, meta);
    if (incoherences.length > 0) {
      await this.quarantine(tenant, dir, fichiers, report, incoherences);
      return;
    }

    const audio = await this.inspecterWav(cheminWav, meta);
    if (!audio.ok) {
      await this.quarantine(tenant, dir, fichiers, report, audio.errors);
      return;
    }

    const relatif = storageRelativePath(tenant.id, radical);
    if (!relatif) return; // déjà écarté par parseRadical, garde de type.

    const sha256 = await sha256DuFichier(cheminWav);
    const existant = await this.prisma.recording.findUnique({
      where: { tenantId_filePath: { tenantId: tenant.id, filePath: relatif } },
      select: { id: true, sha256: true },
    });

    if (existant) {
      await this.traiterRedepot(tenant, dir, fichiers, radical, existant, sha256, report);
      return;
    }

    const destination = join(this.storageDir, relatif);
    await mkdir(dirname(destination), { recursive: true });
    await deplacer(cheminWav, destination);
    // Le json suit son wav : la déclaration d'origine du producteur reste
    // consultable à côté de la preuve qu'elle décrit.
    await deplacer(cheminJson, destination.replace(/\.wav$/i, INGEST_METADATA_EXTENSION));

    try {
      const recording = await this.prisma.recording.create({
        data: {
          tenantId: tenant.id,
          refci: meta.refci,
          near: meta.near,
          far: meta.far,
          direction: meta.direction,
          startedAt: new Date(meta.startedAt),
          durationSec: meta.durationSec,
          filePath: relatif,
          sha256,
          sizeBytes: BigInt(audio.sizeBytes),
          source: sourcePrisma(meta.source),
        },
        select: { id: true },
      });

      await this.audit.record({
        tenantId: tenant.id,
        action: 'INGEST',
        recordingId: recording.id,
        detail: {
          radical,
          filePath: relatif,
          sha256,
          sizeBytes: audio.sizeBytes,
          durationSec: meta.durationSec,
          source: meta.source,
        },
      });
      report.ingested += 1;
    } catch (error) {
      // La base a refusé après le déplacement : on remet le dépôt là où il
      // était pour que le prochain balayage retente, plutôt que de laisser un
      // fichier rangé sans enregistrement.
      await deplacer(destination, cheminWav).catch(() => undefined);
      await deplacer(destination.replace(/\.wav$/i, INGEST_METADATA_EXTENSION), cheminJson).catch(
        () => undefined,
      );
      this.logger.error(
        `Ingestion de ${radical} annulée, dépôt remis en place`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  /**
   * Re-dépôt d'un appel déjà rangé. Même empreinte : no-op tracé, le dépôt
   * est retiré. Empreinte différente sous le même nom : ce n'est pas un
   * doublon mais un conflit — la preuve en place n'est jamais écrasée.
   */
  private async traiterRedepot(
    tenant: TenantRef,
    dir: string,
    fichiers: string[],
    radical: string,
    existant: { id: string; sha256: string },
    sha256: string,
    report: IngestionReport,
  ): Promise<void> {
    if (existant.sha256 !== sha256) {
      await this.quarantine(tenant, dir, fichiers, report, [
        `conflit d'empreinte : « ${radical} » est déjà stocké avec un SHA-256 différent`,
        `attendu ${existant.sha256}, déposé ${sha256}`,
      ]);
      return;
    }

    for (const nom of fichiers) {
      await rm(join(dir, nom), { force: true });
    }
    await this.audit.record({
      tenantId: tenant.id,
      action: 'INGEST',
      recordingId: existant.id,
      detail: { radical, sha256, idempotent: true, motif: 'déjà ingéré, dépôt identique retiré' },
    });
    report.duplicates += 1;
  }

  /** Lit l'en-tête du wav et confronte le fichier à ce que le json annonce. */
  private async inspecterWav(
    chemin: string,
    meta: IngestMetadata,
  ): Promise<{ ok: true; sizeBytes: number } | { ok: false; errors: string[] }> {
    let sizeBytes: number;
    let tete: Uint8Array;
    try {
      sizeBytes = (await stat(chemin)).size;
      const handle = await open(chemin, 'r');
      try {
        const tampon = Buffer.alloc(Math.min(HEADER_BYTES, sizeBytes));
        await handle.read(tampon, 0, tampon.byteLength, 0);
        tete = tampon;
      } finally {
        await handle.close();
      }
    } catch (error) {
      return { ok: false, errors: [`wav illisible : ${(error as Error).message}`] };
    }

    const entete = readWavHeader(tete, sizeBytes);
    if (!entete.ok) return { ok: false, errors: entete.errors };

    const errors: string[] = [];
    if (entete.value.sampleRate !== INGEST_SAMPLE_RATE) {
      errors.push(
        `fréquence ${entete.value.sampleRate} Hz : le contrat §3 attend ${INGEST_SAMPLE_RATE} Hz`,
      );
    }
    const ecart = Math.abs(entete.value.durationSec - meta.durationSec);
    if (ecart > INGEST_DURATION_TOLERANCE_SEC) {
      errors.push(
        `durée incohérente : le json annonce ${meta.durationSec} s, l'audio en contient ${entete.value.durationSec.toFixed(1)}`,
      );
    }
    return errors.length > 0 ? { ok: false, errors } : { ok: true, sizeBytes };
  }

  /** Quarantaine d'un dépôt attribuable à un locataire. */
  private async quarantine(
    tenant: TenantRef,
    dir: string,
    fichiers: string[],
    report: IngestionReport,
    motifs: string[],
  ): Promise<void> {
    const destination = join(this.quarantineDir, tenant.slug);
    await mkdir(destination, { recursive: true });
    for (const nom of fichiers) {
      await deplacer(join(dir, nom), join(destination, nom)).catch((error: unknown) => {
        this.logger.error(`Mise en quarantaine de ${nom} impossible : ${String(error)}`);
      });
    }
    await this.audit.record({
      tenantId: tenant.id,
      action: 'QUARANTINE',
      detail: { fichiers, motifs, destination },
    });
    this.logger.warn(
      `Quarantaine (${tenant.slug}) : ${fichiers.join(', ')} — ${motifs.join(' ; ')}`,
    );
    report.quarantined += fichiers.length;
  }

  /**
   * Quarantaine d'un dépôt qu'aucun locataire ne réclame. L'événement est
   * écrit sans `tenantId` : il n'y a personne à qui l'attribuer, et inventer
   * un locataire serait précisément ce que le contrat §3 interdit.
   */
  private async quarantineInconnu(
    source: string,
    nom: string,
    report: IngestionReport,
    motif: string,
  ): Promise<void> {
    const destination = join(this.quarantineDir, '_inconnu');
    await mkdir(destination, { recursive: true });
    await deplacer(source, join(destination, nom)).catch((error: unknown) => {
      this.logger.error(`Mise en quarantaine de ${nom} impossible : ${String(error)}`);
    });
    await this.audit.record({
      tenantId: null,
      action: 'QUARANTINE',
      detail: { nom, motifs: [motif], destination },
    });
    this.logger.warn(`Quarantaine système : ${nom} — ${motif}`);
    report.quarantined += 1;
  }
}

/**
 * Le radical répète `refci`, `near` et `far` : ils doivent concorder avec le
 * json. Un désaccord signale un dépôt mal fabriqué ou une paire mal
 * appariée — dans les deux cas la métadonnée ne décrit pas l'audio.
 *
 * L'horodatage du radical n'est pas confronté : il est en heure locale du
 * producteur, dont le fuseau n'est pas dans le contrat.
 */
function coherenceNomMetadonnees(radical: string, meta: IngestMetadata): string[] {
  const parsed = parseRadical(radical);
  if (!parsed) return ['nom hors contrat'];
  const ecarts: string[] = [];
  if (parsed.refci !== meta.refci) ecarts.push(`refci : « ${parsed.refci} » ≠ « ${meta.refci} »`);
  if (parsed.near !== meta.near) ecarts.push(`near : « ${parsed.near} » ≠ « ${meta.near} »`);
  if (parsed.far !== meta.far) ecarts.push(`far : « ${parsed.far} » ≠ « ${meta.far} »`);
  return ecarts.length > 0 ? [`nom et métadonnées en désaccord — ${ecarts.join(', ')}`] : [];
}

/** Empreinte du wav, calculée en flux : un enregistrement peut être long. */
async function sha256DuFichier(chemin: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(chemin), hash);
  return hash.digest('hex');
}

/**
 * `rename` échoue entre deux systèmes de fichiers (EXDEV) : INGEST_DIR et
 * STORAGE_DIR sont souvent deux volumes distincts. On retombe alors sur une
 * copie suivie d'une suppression.
 */
async function deplacer(source: string, destination: string): Promise<void> {
  try {
    await rename(source, destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
    const { copyFile } = await import('node:fs/promises');
    await copyFile(source, destination);
    await rm(source, { force: true });
  }
}

/** Le contrat écrit « cucm-bib », l'enum Prisma porte `cucm_bib`. */
function sourcePrisma(source: IngestMetadata['source']): Source {
  return (source === 'cucm-bib' ? 'cucm_bib' : source) as Source;
}
