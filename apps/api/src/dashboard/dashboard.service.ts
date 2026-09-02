import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  DASHBOARD_JOURS,
  DASHBOARD_QUARANTAINES,
  TENANT_TIMEZONE_OFFSET,
  type DashboardJour,
  type DashboardResponse,
} from '@voxecho/shared';
import { PrismaService } from '../prisma/prisma.service';
import { LegalHoldsService } from '../retention/legal-holds.service';
import { RetentionService } from '../retention/retention.service';

/** Statuts dont l'audio est encore sur le disque. */
const CONSERVES = [Prisma.sql`'stored'`, Prisma.sql`'archived'`];

/** Ligne rendue par l'agrégation quotidienne. */
interface LigneJour {
  jour: Date;
  appels: bigint;
  duree: bigint | null;
  octets: bigint | null;
}

@Injectable()
export class DashboardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly retention: RetentionService,
    private readonly holds: LegalHoldsService,
  ) {}

  async lire(tenantId: string): Promise<DashboardResponse> {
    const [totaux, retention, volumeParJour, quarantaines] = await Promise.all([
      this.totaux(tenantId),
      this.retention.lire(tenantId),
      this.volumeParJour(tenantId),
      this.quarantaines(tenantId),
    ]);

    return {
      totaux,
      retention: { days: retention.days, belowFloorReason: retention.belowFloorReason },
      volumeParJour,
      quarantaines,
    };
  }

  private async totaux(tenantId: string): Promise<DashboardResponse['totaux']> {
    const [conserves, purges, sousHold] = await Promise.all([
      this.prisma.recording.aggregate({
        where: { tenantId, status: { in: ['stored', 'archived'] } },
        _count: { _all: true },
        _sum: { durationSec: true, sizeBytes: true },
      }),
      this.prisma.recording.count({ where: { tenantId, status: 'purged' } }),
      this.holds.idsSousHold(tenantId),
    ]);

    return {
      appelsConserves: conserves._count._all,
      dureeSec: conserves._sum.durationSec ?? 0,
      // Le stockage utilisé ne compte que ce qui est réellement sur le
      // disque : un appel purgé garde sa fiche mais ne pèse plus rien.
      stockageOctets: Number(conserves._sum.sizeBytes ?? 0n),
      sousConservationForcee: sousHold.size,
      appelsPurges: purges,
    };
  }

  /**
   * Volume des `DASHBOARD_JOURS` derniers jours, en journées de Douala.
   *
   * Les jours sans appel valent zéro et non « rien » : un graphe qui saute
   * les jours creux dessine une activité continue là où le service a chômé.
   */
  private async volumeParJour(tenantId: string): Promise<DashboardJour[]> {
    // `started_at` est stocké en UTC sans fuseau ; le décalage fixe du produit
    // (§1, pas d'heure d'été) ramène chaque appel à sa journée locale.
    const lignes = await this.prisma.$queryRaw<LigneJour[]>`
      SELECT date_trunc('day', started_at + ${TENANT_TIMEZONE_OFFSET}::interval) AS jour,
             count(*)::bigint            AS appels,
             sum(duration_sec)::bigint   AS duree,
             sum(size_bytes)::bigint     AS octets
        FROM recordings
       WHERE tenant_id = ${tenantId}::uuid
         AND status IN (${Prisma.join(CONSERVES)})
         AND started_at >= now() - ${`${DASHBOARD_JOURS} days`}::interval
       GROUP BY 1
       ORDER BY 1
    `;

    const parJour = new Map(
      lignes.map((ligne) => [
        jourLocal(ligne.jour),
        {
          appels: Number(ligne.appels),
          dureeSec: Number(ligne.duree ?? 0n),
          octets: Number(ligne.octets ?? 0n),
        },
      ]),
    );

    return fenetre(DASHBOARD_JOURS).map((jour) => ({
      jour,
      appels: parJour.get(jour)?.appels ?? 0,
      dureeSec: parJour.get(jour)?.dureeSec ?? 0,
      octets: parJour.get(jour)?.octets ?? 0,
    }));
  }

  /**
   * Dernières quarantaines du locataire. Celles qu'aucun locataire ne réclame
   * (§9.2) n'y figurent pas : elles ne sont lisibles que par l'ADMIN de
   * l'instance, depuis le journal.
   */
  private async quarantaines(tenantId: string): Promise<DashboardResponse['quarantaines']> {
    const evenements = await this.prisma.auditEvent.findMany({
      where: { tenantId, action: 'QUARANTINE' },
      orderBy: { at: 'desc' },
      take: DASHBOARD_QUARANTAINES,
      select: { id: true, at: true, detail: true },
    });

    return evenements.map((evenement) => ({
      id: evenement.id,
      at: evenement.at.toISOString(),
      motif: motifLisible(evenement.detail),
    }));
  }
}

/** `yyyy-mm-dd` de la journée locale déjà décalée par la requête. */
function jourLocal(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Les N derniers jours locaux, du plus ancien au plus récent, sans trou. */
function fenetre(jours: number): string[] {
  const decalageMs = decalageEnMs(TENANT_TIMEZONE_OFFSET);
  const aujourdhui = new Date(Date.now() + decalageMs);
  const suite: string[] = [];
  for (let recul = jours - 1; recul >= 0; recul -= 1) {
    const jour = new Date(aujourdhui);
    jour.setUTCDate(jour.getUTCDate() - recul);
    suite.push(jour.toISOString().slice(0, 10));
  }
  return suite;
}

function decalageEnMs(offset: string): number {
  const [, signe, heures, minutes] = /^([+-])(\d{2}):(\d{2})$/.exec(offset) ?? [];
  if (!signe || !heures || !minutes) return 0;
  const ms = (Number(heures) * 60 + Number(minutes)) * 60_000;
  return signe === '-' ? -ms : ms;
}

/**
 * Motif d'une quarantaine, tel qu'il a été consigné. L'ingestion écrit un
 * `motif` explicite ; à défaut, on rend le détail brut plutôt qu'un « — »
 * qui laisserait croire qu'on n'en sait rien.
 */
function motifLisible(detail: unknown): string {
  if (detail === null || typeof detail !== 'object') return 'motif non consigné';
  const enregistre = detail as Record<string, unknown>;
  if (typeof enregistre.motif === 'string') return enregistre.motif;
  if (Array.isArray(enregistre.motifs)) return enregistre.motifs.join(' ; ');
  if (typeof enregistre.raison === 'string') return enregistre.raison;
  return JSON.stringify(detail);
}
