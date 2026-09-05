import { createHash } from 'node:crypto';
import { Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  CERTIFICAT_SCHEMA,
  type CertificatDestruction,
  type CertificatLigne,
} from '@voxecho/shared';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Certificat de destruction — CLAUDE.md §9.31.
 *
 * Le §9.7 avait posé le principe : ce qui reste d'un appel purgé, c'est sa
 * fiche et son empreinte. Le certificat rassemble ces restes en une pièce
 * unique, que la banque range dans son dossier de conformité — parce qu'un
 * contrôleur ne demandera pas « montrez-moi la base », il demandera « qu'avez-
 * vous détruit, et sur l'ordre de qui ? ».
 *
 * Il se construit depuis le rapport, jamais depuis les enregistrements : ceux
 * qui ont été détruits n'ont plus de fichier, et leurs lignes pourraient être
 * purgées à leur tour un jour.
 */
@Injectable()
export class CertificatService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Empreinte du **contenu**, non du fichier. Le PDF et le CSV du même rapport
   * rendent donc la même valeur : c'est elle qui identifie ce qui a été
   * détruit, indépendamment de la forme sous laquelle on le présente.
   *
   * Les clés sont triées, faute de quoi deux sérialisations du même certificat
   * donneraient deux empreintes et la vérification ne prouverait rien.
   */
  empreinte(certificat: CertificatDestruction): string {
    return createHash('sha256').update(canonique(certificat)).digest('hex');
  }

  /**
   * Construit le certificat. `client` permet de le bâtir **dans** la
   * transaction qui scelle l'exécution : l'empreinte, le passage du rapport à
   * « exécuté » et l'événement au journal tiennent alors ou tombent ensemble
   * (§9.34).
   */
  async construire(
    tenantId: string,
    rapportId: string,
    client?: Prisma.TransactionClient,
  ): Promise<CertificatDestruction> {
    const run = await (client ?? this.prisma).purgeRun.findFirst({
      where: { id: rapportId, tenantId },
      include: {
        tenant: { select: { name: true } },
        createdByUser: { select: { email: true } },
        executedByUser: { select: { email: true } },
        items: {
          include: { recording: { select: { refci: true, sha256: true } } },
          orderBy: { startedAt: 'asc' },
        },
      },
    });
    if (!run) throw new NotFoundException('Rapport de purge introuvable.');
    if (run.status !== 'executed') {
      // Un rapport simulé n'a rien détruit : délivrer un certificat pour une
      // destruction qui n'a pas eu lieu serait un faux.
      throw new NotFoundException(
        'Ce rapport n’a pas été exécuté : il n’y a pas de destruction à certifier.',
      );
    }

    const motifs = run.executionReason ?? (await this.motifsDePurge(tenantId, run.id, client));

    const detruits: CertificatLigne[] = run.items
      .filter((item) => item.outcome === 'purged' || item.outcome === 'missing')
      .map((item) => ({
        recordingId: item.recordingId,
        refci: item.recording.refci,
        debuteLe: item.startedAt.toISOString(),
        categorie: item.operationCategory ?? 'non renseignée',
        dureeAppliqueeJours: item.policyDays ?? run.policyDays,
        octets: Number(item.sizeBytes),
        sha256: item.recording.sha256,
        fichierDejaAbsent: item.outcome === 'missing',
      }));

    return {
      schema: CERTIFICAT_SCHEMA,
      produit: 'VoxEcho Record',
      rapportId: run.id,
      locataire: { id: run.tenantId, nom: run.tenant.name },
      politiqueAppliquee: (run.policyDocument as Record<string, number> | null) ?? {
        all: run.policyDays,
      },
      echeance: run.cutoff.toISOString(),
      demandeLe: run.createdAt.toISOString(),
      demandePar: run.createdByUser.email,
      executeLe: (run.executedAt ?? run.createdAt).toISOString(),
      executePar: run.executedByUser?.email ?? 'inconnu',
      motif: motifs,
      detruits,
      epargnes: run.items
        .filter((item) => item.blocked)
        .map((item) => ({
          recordingId: item.recordingId,
          refci: item.recording.refci,
          motifConservation: item.blockingReason,
        })),
      totaux: {
        detruits: detruits.length,
        octets: detruits.reduce((total, ligne) => total + ligne.octets, 0),
        epargnes: run.items.filter((item) => item.blocked).length,
      },
      // Une purge peut n'avoir rien trouvé à détruire : c'est un fait à
      // attester, pas un incident. La mention le dit plutôt que d'affirmer
      // que « les enregistrements ci-dessus ont été détruits » au-dessus
      // d'une liste vide.
      // Deux mentions plutôt qu'un tronc commun : « leurs empreintes
      // subsistent » ne renvoie à rien quand rien n'a été détruit.
      mention:
        detruits.length === 0
          ? 'Aucun enregistrement n’était échu au regard des durées de conservation figées ' +
            'par ce rapport : la purge a été exécutée et n’a détruit aucune pièce. ' +
            'L’exécution est inscrite au journal d’audit, qui est append-only. Ce ' +
            'certificat se vérifie par son empreinte, inscrite au journal.'
          : 'Les enregistrements audio listés ci-dessus ont été détruits. Leurs empreintes, ' +
            'tailles et dates subsistent dans le journal d’audit, qui est append-only. Ce ' +
            'certificat se vérifie par son empreinte, inscrite au journal.',
    };
  }

  /**
   * L'empreinte figée à l'instant de la destruction — CLAUDE.md §9.31.
   *
   * C'est elle qui fait foi, et non celle qu'on recalcule au téléchargement :
   * un certificat délivré des mois plus tard doit porter la valeur de ce
   * jour-là. Nulle sur un rapport exécuté avant que cette colonne n'existe.
   */
  async empreinteFigee(tenantId: string, rapportId: string): Promise<string | null> {
    const run = await this.prisma.purgeRun.findFirst({
      where: { id: rapportId, tenantId },
      select: { certificateSha256: true },
    });
    return run?.certificateSha256 ?? null;
  }

  /**
   * Le motif de destruction, relu au journal. Ce chemin ne sert plus que pour
   * les rapports exécutés avant que `PurgeRun.executionReason` n'existe : il
   * ne rend rien quand la purge n'a détruit aucune pièce, faute d'un `PURGE`
   * à lire.
   */
  private async motifsDePurge(
    tenantId: string,
    rapportId: string,
    client?: Prisma.TransactionClient,
  ): Promise<string> {
    const trace = await (client ?? this.prisma).auditEvent.findFirst({
      where: { tenantId, action: 'PURGE', detail: { path: ['rapportId'], equals: rapportId } },
      orderBy: { at: 'asc' },
    });
    const detail = trace?.detail as { motif?: string } | null;
    return detail?.motif ?? 'motif non consigné';
  }
}

/**
 * Sérialisation stable : clés triées à tous les niveaux. Deux certificats
 * identiques doivent donner deux fois la même empreinte, quelle que soit
 * l'ordre dans lequel les champs ont été construits.
 */
export function canonique(valeur: unknown): string {
  return JSON.stringify(trier(valeur));
}

function trier(valeur: unknown): unknown {
  if (Array.isArray(valeur)) return valeur.map(trier);
  if (valeur !== null && typeof valeur === 'object') {
    return Object.fromEntries(
      Object.entries(valeur as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([cle, sous]) => [cle, trier(sous)]),
    );
  }
  return valeur;
}
