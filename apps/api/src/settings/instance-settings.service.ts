import { ConflictException, Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthUser } from '../auth/auth.types';
import { masquerSecrets, porteUnSecret } from './secrets';

/** Une section telle qu'elle vit en base, avec de quoi écrire par-dessus. */
export interface SectionLue<T> {
  valeur: T;
  version: number;
  updatedAt: Date | null;
  updatedByEmail: string | null;
}

/**
 * Réglages d'instance — CLAUDE.md §9.36.
 *
 * Une ligne par **section**, versionnée. Le service ne connaît aucune section
 * en particulier : il lit, écrit, journalise et met en cache. Ce que chaque
 * section contient et vaut par défaut est l'affaire de son propre service.
 *
 * Le défaut vit dans le code : une table vide est une instance qui fonctionne,
 * et une ligne absente ne dit pas la même chose qu'une ligne nulle.
 */
@Injectable()
export class InstanceSettingsService {
  private readonly logger = new Logger(InstanceSettingsService.name);

  /**
   * Cache mémoire, invalidé à l'écriture. Les réglages sont lus à chaque
   * requête — le fuseau d'affichage, les relais de confiance — et relus en base
   * à chaque fois pour rien.
   */
  private readonly cache = new Map<string, SectionLue<unknown>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Lit une section, ou rend le défaut fourni si elle n'a jamais été écrite. */
  async lire<T>(cle: string, defaut: T): Promise<SectionLue<T>> {
    const enCache = this.cache.get(cle);
    if (enCache) return enCache as SectionLue<T>;

    const ligne = await this.prisma.instanceSetting.findUnique({
      where: { key: cle },
      include: { editeur: { select: { email: true } } },
    });

    const lue: SectionLue<T> = ligne
      ? {
          // La section stockée peut être plus ancienne que le code : les champs
          // que le défaut connaît et qu'elle n'a pas restent au défaut.
          valeur: { ...defaut, ...(ligne.value as object) } as T,
          version: ligne.version,
          updatedAt: ligne.updatedAt,
          updatedByEmail: ligne.editeur?.email ?? null,
        }
      : { valeur: defaut, version: 0, updatedAt: null, updatedByEmail: null };

    this.cache.set(cle, lue);
    return lue;
  }

  /**
   * Écrit une section et l'inscrit au journal.
   *
   * `versionAttendue` est celle que l'appelant a lue. Si elle a bougé, on
   * refuse : deux administrateurs modifiant la même section s'écraseraient, et
   * le second ne saurait même pas ce qu'il a effacé (§9.36).
   */
  async ecrire<T extends object>(
    cle: string,
    valeur: T,
    versionAttendue: number,
    user: AuthUser,
    ip: string | null,
    defaut: T,
  ): Promise<SectionLue<T>> {
    const avant = await this.lire(cle, defaut);
    if (avant.version !== versionAttendue) {
      throw new ConflictException(
        `Ce réglage a été modifié depuis son ouverture (version ${avant.version}, la vôtre ${versionAttendue}). Rechargez avant d’écrire.`,
      );
    }

    const version = avant.version + 1;
    const ligne = await this.prisma.instanceSetting.upsert({
      where: { key: cle },
      create: {
        key: cle,
        value: valeur as unknown as Prisma.InputJsonValue,
        version,
        updatedBy: user.userId,
      },
      update: {
        value: valeur as unknown as Prisma.InputJsonValue,
        version,
        updatedBy: user.userId,
      },
      include: { editeur: { select: { email: true } } },
    });

    this.cache.delete(cle);

    // Les secrets ne voyagent pas au journal, même vers une table que personne
    // ne peut modifier. `secretRemplace` dit ce que deux masques identiques ne
    // diraient pas.
    await this.audit.record({
      tenantId: null,
      userId: user.userId,
      action: 'SETTINGS_SET',
      ip,
      detail: {
        reglage: cle,
        versionAvant: avant.version,
        versionApres: version,
        avant: masquerSecrets(avant.valeur) as Prisma.InputJsonValue,
        apres: masquerSecrets(valeur) as Prisma.InputJsonValue,
        secretRemplace: porteUnSecret(valeur) && !this.memesSecrets(avant.valeur, valeur),
      },
    });

    this.logger.log(`Réglage ${cle} modifié par ${user.email} (version ${version})`);

    return {
      valeur: { ...defaut, ...(ligne.value as object) } as T,
      version: ligne.version,
      updatedAt: ligne.updatedAt,
      updatedByEmail: ligne.editeur?.email ?? null,
    };
  }

  /** Consigne le résultat d'un test, qu'il ait réussi ou non (§9.36). */
  async tracerTest(
    cle: string,
    user: AuthUser,
    ip: string | null,
    resultat: { reussi: boolean; detail: Prisma.InputJsonValue },
  ): Promise<void> {
    await this.audit.record({
      tenantId: null,
      userId: user.userId,
      action: 'SETTINGS_TEST',
      ip,
      detail: { reglage: cle, reussi: resultat.reussi, resultat: resultat.detail },
    });
  }

  /** Vide le cache. Utile aux tests et à une commande d'exploitation. */
  oublier(cle?: string): void {
    if (cle === undefined) this.cache.clear();
    else this.cache.delete(cle);
  }

  /** Les conteneurs de secret sont-ils inchangés d'une version à l'autre ? */
  private memesSecrets(avant: unknown, apres: unknown): boolean {
    return JSON.stringify(this.secrets(avant)) === JSON.stringify(this.secrets(apres));
  }

  private secrets(valeur: unknown): string[] {
    if (valeur === null || typeof valeur !== 'object') return [];
    if (Array.isArray(valeur)) return valeur.flatMap((v) => this.secrets(v));
    const entrees = Object.entries(valeur as Record<string, unknown>);
    return entrees.flatMap(([cle, v]) =>
      cle === 'chiffre' && typeof v === 'string' ? [v] : this.secrets(v),
    );
  }
}
