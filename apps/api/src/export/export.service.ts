import { createHash, randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { basename, join, resolve, sep } from 'node:path';
import { GoneException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import JSZip from 'jszip';
import { construireFichePdf } from './fiche-pdf';
import {
  EXPORT_FICHE_JSON,
  EXPORT_FICHE_PDF,
  EXPORT_MANIFEST_VERSION,
  type ExportIntegrite,
  type ExportManifest,
} from '@voxecho/shared';
import { AuditService } from '../audit/audit.service';
import { resoudreCheminDeDonnees } from '../config/chemins';
import { AppConfig } from '../config/config.module';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthUser } from '../auth/auth.types';
import { LegalHoldsService } from '../retention/legal-holds.service';
import { StorageService } from '../storage/storage.service';

const PRODUIT = 'VoxEcho Record';
const MENTION =
  'Cet export a été inscrit au journal d’audit de VoxEcho Record : sa demande, son auteur et son horodatage y figurent. La fiche accompagne le fichier audio ; séparés, ils ne prouvent plus rien l’un de l’autre.';

/** Archive prête à être servie. */
export interface ArchiveExport {
  contenu: Buffer;
  nomArchive: string;
  exportId: string;
  integrite: ExportIntegrite;
}

@Injectable()
export class ExportService {
  private readonly logger = new Logger(ExportService.name);
  private readonly storageDir: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly holds: LegalHoldsService,
    private readonly stockage: StorageService,
    config: AppConfig,
  ) {
    this.storageDir = resoudreCheminDeDonnees(config.get('STORAGE_DIR'));
  }

  /**
   * Fabrique l'archive d'un appel : l'audio, la fiche PDF, la fiche JSON.
   *
   * L'empreinte est **recalculée sur le fichier au moment de l'export**, et
   * confrontée à celle relevée à l'ingestion. C'est l'intérêt de la
   * manœuvre : la fiche n'affirme pas que la pièce est intacte parce que la
   * base le dit, elle le vérifie et le date.
   */
  async exporter(user: AuthUser, recordingId: string, ip: string | null): Promise<ArchiveExport> {
    const recording = await this.prisma.recording.findFirst({
      where: { id: recordingId, tenantId: user.tenantId },
      include: { tenant: { select: { id: true, name: true } } },
    });
    if (!recording) throw new NotFoundException('Enregistrement introuvable.');
    if (recording.status === 'purged') {
      throw new GoneException('Enregistrement purgé : il n’y a plus d’audio à exporter.');
    }

    const chemin = resolve(join(this.storageDir, recording.filePath));
    if (chemin !== this.storageDir && !chemin.startsWith(this.storageDir + sep)) {
      this.logger.error(`Chemin hors STORAGE_DIR refusé à l’export : ${recording.filePath}`);
      throw new NotFoundException('Enregistrement introuvable.');
    }

    let audio: Buffer;
    try {
      await stat(chemin);
      // Le clair, que la pièce soit scellée sur le disque ou non : ce qui
      // sort du produit est toujours le wav ingéré (§9.13).
      audio = await this.stockage.lireEntier({
        recordingId: recording.id,
        chemin,
        encrypted: recording.encrypted,
      });
    } catch (erreur) {
      this.logger.error(
        `Lecture impossible pour l'export de ${recording.filePath}`,
        erreur instanceof Error ? erreur.stack : String(erreur),
      );
      throw new NotFoundException('Fichier audio introuvable dans le stockage.');
    }

    const sha256Export = createHash('sha256').update(audio).digest('hex');
    const integrite: ExportIntegrite =
      sha256Export === recording.sha256 ? 'concordante' : 'divergente';

    if (integrite === 'divergente') {
      // Ce n'est pas une erreur de requête, c'est un incident d'intégrité sur
      // une pièce probante. Il se crie dans les journaux du serveur autant
      // qu'il s'écrit sur la fiche.
      this.logger.error(
        `Intégrité rompue à l'export de ${recording.id} : base ${recording.sha256}, disque ${sha256Export}`,
      );
    }

    const sousHold = await this.holds.idsSousHold(user.tenantId, [recording.id]);
    const exportId = randomUUID();
    const nomAudio = basename(recording.filePath);

    const manifest: ExportManifest = {
      schema: EXPORT_MANIFEST_VERSION,
      produit: PRODUIT,
      exportId,
      emisLe: new Date().toISOString(),
      demandeur: { id: user.userId, email: user.email, role: user.role },
      locataire: { id: recording.tenant.id, nom: recording.tenant.name },
      appel: {
        id: recording.id,
        refci: recording.refci,
        poste: recording.near,
        correspondant: recording.far,
        sens: recording.direction,
        debuteLe: recording.startedAt.toISOString(),
        dureeSec: recording.durationSec,
        source: recording.source === 'cucm_bib' ? 'cucm-bib' : recording.source,
        statut: recording.status,
        categorieOperation: recording.operationCategory,
        sousConservationForcee: sousHold.has(recording.id),
      },
      preuve: {
        sha256Ingestion: recording.sha256,
        sha256Export,
        integrite,
        octets: audio.byteLength,
        fichierAudio: nomAudio,
      },
      mention: MENTION,
    };

    const pdf = await construireFichePdf(manifest);

    const zip = new JSZip();
    zip.file(nomAudio, audio);
    zip.file(EXPORT_FICHE_PDF, pdf);
    zip.file(EXPORT_FICHE_JSON, JSON.stringify(manifest, null, 2));
    const contenu = await zip.generateAsync({ type: 'nodebuffer' });

    await this.audit.record({
      tenantId: user.tenantId,
      userId: user.userId,
      action: 'EXPORT',
      recordingId: recording.id,
      ip,
      detail: {
        exportId,
        refci: recording.refci,
        sha256Ingestion: recording.sha256,
        sha256Export,
        // Le journal porte le résultat de la vérification, pas seulement le
        // fait qu'un export a eu lieu : c'est ce qui permet de retrouver
        // quand une pièce a commencé à diverger.
        integrite,
        octets: audio.byteLength,
        fichiers: [nomAudio, EXPORT_FICHE_PDF, EXPORT_FICHE_JSON],
      },
    });

    return {
      contenu,
      // Le nom du fichier rangé porte déjà date, refci, poste et
      // correspondant (contrat §3) : l'archive n'a rien à y ajouter.
      nomArchive: `export-${nomAudio.replace(/\.wav$/i, '')}.zip`,
      exportId,
      integrite,
    };
  }
}
