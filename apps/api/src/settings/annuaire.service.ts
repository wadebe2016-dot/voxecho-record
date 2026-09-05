import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import type { Prisma, User } from '@prisma/client';
import {
  ANNUAIRE_FILTRE_DEFAUT,
  ATTRIBUTS_DEFAUT,
  type MajReglagesAnnuaireRequest,
  type RegleAnnuaire,
  type ReglagesAnnuaire,
  type ReglagesAnnuaireResponse,
  type ResultatTestAnnuaire,
  type Role,
} from '@voxecho/shared';
import { AuditService } from '../audit/audit.service';
import { AppConfig } from '../config/config.module';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthUser } from '../auth/auth.types';
import {
  AnnuaireInjoignable,
  AnnuaireLdap,
  type Annuaire,
  type CompteAnnuaire,
} from './annuaire-client';
import { InstanceSettingsService } from './instance-settings.service';
import { chiffrerSecret, dechiffrerSecret, estSecretChiffre, SECRET_MASQUE } from './secrets';

export const CLE_ANNUAIRE = 'annuaire';

/** Ce que la section porte en base : comme le contrat, mais secret chiffré. */
interface AnnuaireEnBase extends Omit<ReglagesAnnuaire, 'bindMotDePasse'> {
  bindMotDePasse: { chiffre: string } | null;
}

export const ANNUAIRE_DEFAUT: AnnuaireEnBase = {
  actif: false,
  url: null,
  startTls: false,
  verifierCertificat: true,
  acPem: null,
  baseDn: null,
  bindDn: null,
  bindMotDePasse: null,
  filtre: ANNUAIRE_FILTRE_DEFAUT,
  attributs: ATTRIBUTS_DEFAUT,
  regles: [],
  synchro: { actif: true, intervalleHeures: 6 },
};

/** Du plus fort au plus faible : plusieurs groupes donnent le rôle le plus élevé. */
const FORCE_DES_ROLES: Role[] = ['ADMIN', 'SUPERVISOR', 'AUDITOR'];

/** Ce qu'une tentative d'authentification par annuaire peut donner. */
export type VerdictAnnuaire =
  | { issue: 'inactif' }
  | { issue: 'introuvable' }
  | { issue: 'identifiants' }
  | { issue: 'injoignable'; message: string }
  | { issue: 'non_mappe'; groupes: string[]; login: string }
  | { issue: 'conflit_local'; email: string }
  | { issue: 'admis'; compte: User; cree: boolean };

/**
 * Annuaire d'entreprise — CLAUDE.md §9.37.
 *
 * L'annuaire décide qui entre et avec quel rôle, donc qui peut entendre des
 * conversations de clients. Trois règles gouvernent tout ce service : rien
 * n'est créé sans correspondance écrite, un compte local n'est jamais repris
 * en silence, et il doit toujours rester un administrateur local actif.
 */
@Injectable()
export class AnnuaireService {
  private readonly logger = new Logger(AnnuaireService.name);

  /** Dernière synchronisation, en mémoire : c'est un constat, pas une preuve. */
  private derniereSynchro: { le: string; desactives: number; vus: number } | null = null;

  /** Remplaçable dans les tests : le chemin d'authentification s'éprouve sans serveur. */
  fabriquerAnnuaire: (reglages: AnnuaireEnBase, motDePasse: string) => Annuaire = (
    reglages,
    motDePasse,
  ) =>
    new AnnuaireLdap({
      url: reglages.url ?? '',
      startTls: reglages.startTls,
      verifierCertificat: reglages.verifierCertificat,
      acPem: reglages.acPem,
      baseDn: reglages.baseDn ?? '',
      bindDn: reglages.bindDn ?? '',
      bindMotDePasse: motDePasse,
      filtre: reglages.filtre,
      attributs: reglages.attributs,
    });

  constructor(
    private readonly prisma: PrismaService,
    private readonly reglages: InstanceSettingsService,
    private readonly audit: AuditService,
    private readonly config: AppConfig,
  ) {}

  private cleMaitre(): Buffer {
    const brute = Buffer.from(this.config.get('STORAGE_MASTER_KEY'), 'base64');
    if (brute.length !== 32) {
      // Un secret qu'on ne saurait pas relire est pire qu'un secret absent :
      // on le dit à la saisie plutôt qu'à la première connexion d'un auditeur.
      throw new BadRequestException(
        'Aucune clé maître utilisable : STORAGE_MASTER_KEY doit porter 32 octets en base64 pour chiffrer le mot de passe de liaison.',
      );
    }
    return brute;
  }

  private async section(): Promise<{ valeur: AnnuaireEnBase; version: number }> {
    return this.reglages.lire(CLE_ANNUAIRE, ANNUAIRE_DEFAUT);
  }

  async lire(): Promise<ReglagesAnnuaireResponse> {
    const section = await this.reglages.lire(CLE_ANNUAIRE, ANNUAIRE_DEFAUT);
    const locataires = await this.prisma.tenant.findMany({
      where: { active: true },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });

    return {
      reglages: {
        ...section.valeur,
        // Jamais la valeur : un champ pré-rempli d'un masque finit renvoyé tel
        // quel, et le masque devient le secret (§9.36).
        bindMotDePasse: section.valeur.bindMotDePasse === null ? null : SECRET_MASQUE,
      },
      version: section.version,
      updatedAt: section.updatedAt?.toISOString() ?? null,
      updatedByEmail: section.updatedByEmail,
      locataires: locataires.map((t) => ({ id: t.id, nom: t.name })),
      derniereSynchro: this.derniereSynchro,
    };
  }

  async definir(
    demande: MajReglagesAnnuaireRequest,
    user: AuthUser,
    ip: string | null,
  ): Promise<ReglagesAnnuaireResponse> {
    const avant = await this.section();
    const propre = await this.valider(demande.reglages);

    // Le secret n'est remplacé que lorsqu'on en envoie un : sinon l'ancien
    // demeure, et l'écran n'a pas eu à le faire voyager pour rien.
    const bindMotDePasse =
      demande.bindMotDePasse === undefined || demande.bindMotDePasse === ''
        ? avant.valeur.bindMotDePasse
        : chiffrerSecret(this.cleMaitre(), demande.bindMotDePasse);

    await this.reglages.ecrire(
      CLE_ANNUAIRE,
      { ...propre, bindMotDePasse },
      demande.version,
      user,
      ip,
      ANNUAIRE_DEFAUT,
    );
    return this.lire();
  }

  /** Teste la liaison, puis cherche un login si on en a donné un. */
  async tester(
    login: string | undefined,
    user: AuthUser,
    ip: string | null,
  ): Promise<ResultatTestAnnuaire> {
    const { valeur } = await this.section();
    const resultat: ResultatTestAnnuaire = {
      bind: { reussi: false, message: '' },
      recherche: null,
      correspondance: null,
    };

    try {
      const annuaire = this.annuaire(valeur);
      if (login === undefined || login.trim() === '') {
        // Sans login, on ne peut vérifier la liaison qu'en cherchant quelque
        // chose : une recherche qui ne trouve rien prouve quand même le bind.
        await annuaire.chercher('__verification-de-liaison__');
        resultat.bind = { reussi: true, message: 'Liaison au compte de service réussie.' };
      } else {
        const compte = await annuaire.chercher(login.trim());
        resultat.bind = { reussi: true, message: 'Liaison au compte de service réussie.' };
        resultat.recherche =
          compte === null
            ? {
                tentee: true,
                trouve: false,
                message: `Aucun compte ne correspond à « ${login.trim()} ».`,
                dn: null,
                login: null,
                email: null,
                nomAffiche: null,
                groupes: [],
              }
            : {
                tentee: true,
                trouve: true,
                message: 'Compte trouvé.',
                dn: compte.dn,
                login: compte.login,
                email: compte.email,
                nomAffiche: compte.nomAffiche,
                groupes: compte.groupes,
              };
        if (compte !== null) {
          const regle = this.correspondance(compte.groupes, valeur.regles);
          resultat.correspondance =
            regle === null
              ? null
              : { role: regle.role, tenantId: regle.tenantId, groupeDn: regle.groupeDn };
        }
      }
    } catch (e) {
      resultat.bind = {
        reussi: false,
        message: e instanceof Error ? e.message : 'Échec de la liaison.',
      };
    }

    await this.reglages.tracerTest(CLE_ANNUAIRE, user, ip, {
      reussi: resultat.bind.reussi && (resultat.recherche?.trouve ?? true),
      detail: {
        bind: resultat.bind.reussi,
        message: resultat.bind.message,
        login: login ?? null,
        trouve: resultat.recherche?.trouve ?? null,
        groupes: resultat.recherche?.groupes ?? [],
        roleMappe: resultat.correspondance?.role ?? null,
      },
    });

    return resultat;
  }

  /**
   * Tente d'authentifier par l'annuaire — CLAUDE.md §9.37.
   *
   * Rend un verdict plutôt qu'un booléen : l'appelant doit pouvoir distinguer
   * « pas de compte » de « annuaire éteint » et de « aucun groupe mappé »,
   * qui ne se journalisent ni ne se disent de la même façon.
   */
  async authentifier(login: string, motDePasse: string, ip: string | null): Promise<VerdictAnnuaire> {
    const { valeur } = await this.section();
    if (!valeur.actif) return { issue: 'inactif' };

    let compte: CompteAnnuaire | null;
    try {
      const annuaire = this.annuaire(valeur);
      compte = await annuaire.chercher(login);
      if (compte === null) return { issue: 'introuvable' };
      if (!(await annuaire.verifierIdentifiants(compte.dn, motDePasse))) {
        return { issue: 'identifiants' };
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Annuaire injoignable.';
      // Les sessions ouvertes vivent leur vie ; seules les nouvelles
      // connexions sont refusées, et l'incident se voit à l'écran d'état.
      await this.audit.record({
        tenantId: null,
        action: 'LOGIN',
        ip,
        detail: { resultat: 'annuaire_injoignable', login, message },
      });
      return { issue: 'injoignable', message };
    }

    const regle = this.correspondance(compte.groupes, valeur.regles);
    if (regle === null) {
      await this.audit.record({
        tenantId: null,
        action: 'LOGIN',
        ip,
        // Les groupes vus sont consignés : sans eux, « aucun groupe mappé »
        // n'aide pas l'administrateur à écrire la règle qui manque.
        detail: { resultat: 'annuaire_non_mappe', login, groupes: compte.groupes },
      });
      return { issue: 'non_mappe', groupes: compte.groupes, login };
    }

    const email = (compte.email ?? `${login}@annuaire.local`).trim().toLowerCase();
    const existant = await this.prisma.user.findUnique({ where: { email } });

    if (existant !== null && existant.source === 'local') {
      // Reprendre un compte local reviendrait à changer son autorité sans que
      // personne ne l'ait décidé. Il faut un acte d'administration explicite.
      await this.audit.record({
        tenantId: existant.tenantId,
        userId: existant.id,
        action: 'LOGIN',
        ip,
        detail: { resultat: 'annuaire_conflit_local', login, email },
      });
      return { issue: 'conflit_local', email };
    }

    if (existant !== null) {
      const majour = await this.prisma.user.update({
        where: { id: existant.id },
        data: {
          role: regle.role,
          tenantId: regle.tenantId,
          active: true,
          externalId: compte.externalId ?? existant.externalId,
          directorySeenAt: new Date(),
          failedLoginAttempts: 0,
          lockedUntil: null,
        },
      });
      return { issue: 'admis', compte: majour, cree: false };
    }

    const cree = await this.prisma.user.create({
      data: {
        tenantId: regle.tenantId,
        email,
        // Pas de mot de passe local : lui en donner un ouvrirait une seconde
        // porte que l'annuaire ne fermerait pas en désactivant le compte.
        passwordHash: null,
        source: 'ad',
        externalId: compte.externalId,
        role: regle.role,
        // Exclu du renouvellement : il n'y a pas de mot de passe à renouveler.
        mustChangePassword: false,
        directorySeenAt: new Date(),
      },
    });

    await this.audit.record({
      tenantId: cree.tenantId,
      userId: cree.id,
      action: 'USER_SET',
      ip,
      detail: {
        acte: 'provisionnement_annuaire',
        cible: cree.email,
        role: cree.role,
        groupeDn: regle.groupeDn,
      },
    });

    return { issue: 'admis', compte: cree, cree: true };
  }

  /**
   * Synchronisation périodique — CLAUDE.md §9.37.
   *
   * Elle ne crée rien : un compte naît d'une connexion réussie. Elle **retire**
   * — désactive les comptes d'annuaire qui n'y sont plus, ou qui sont sortis
   * des groupes mappés. C'est le seul mécanisme qui ferme une porte sans qu'un
   * humain l'ait fait, et c'est pourquoi il ne fait que désactiver.
   */
  async synchroniser(): Promise<{ vus: number; desactives: number }> {
    const { valeur } = await this.section();
    if (!valeur.actif || !valeur.synchro.actif) return { vus: 0, desactives: 0 };

    const comptes = await this.prisma.user.findMany({ where: { source: 'ad', active: true } });
    if (comptes.length === 0) return { vus: 0, desactives: 0 };

    const annuaire = this.annuaire(valeur);
    let vus = 0;
    let desactives = 0;

    for (const compte of comptes) {
      const login = compte.email.split('@')[0] ?? compte.email;
      const trouve = await annuaire.chercher(login).catch(() => {
        // Un annuaire injoignable ne doit désactiver personne : on ne ferme
        // pas des portes sur une panne de réseau.
        throw new AnnuaireInjoignable('synchronisation interrompue');
      });

      if (trouve !== null) {
        vus += 1;
        if (this.correspondance(trouve.groupes, valeur.regles) !== null) {
          await this.prisma.user.update({
            where: { id: compte.id },
            data: { directorySeenAt: new Date() },
          });
          continue;
        }
      }

      await this.prisma.user.update({ where: { id: compte.id }, data: { active: false } });
      desactives += 1;
      await this.audit.record({
        tenantId: compte.tenantId,
        userId: compte.id,
        action: 'USER_SET',
        detail: {
          acte: 'desactivation_synchronisation',
          cible: compte.email,
          motif: trouve === null ? 'absent de l’annuaire' : 'sorti des groupes mappés',
        },
      });
    }

    this.derniereSynchro = { le: new Date().toISOString(), desactives, vus };
    this.logger.log(`Synchronisation annuaire : ${vus} compte(s) vu(s), ${desactives} désactivé(s)`);
    return { vus, desactives };
  }

  /** Le rôle le plus élevé parmi les groupes reconnus, ou rien. */
  correspondance(groupes: string[], regles: RegleAnnuaire[]): RegleAnnuaire | null {
    const normalises = new Set(groupes.map((g) => g.trim().toLowerCase()));
    const retenues = regles.filter((regle) => normalises.has(regle.groupeDn.trim().toLowerCase()));
    if (retenues.length === 0) return null;
    return retenues.sort(
      (a, b) => FORCE_DES_ROLES.indexOf(a.role) - FORCE_DES_ROLES.indexOf(b.role),
    )[0] as RegleAnnuaire;
  }

  private annuaire(reglages: AnnuaireEnBase): Annuaire {
    if (reglages.url === null || reglages.bindDn === null || reglages.baseDn === null) {
      throw new BadRequestException(
        'Annuaire incomplet : url, base DN et compte de liaison sont requis.',
      );
    }
    const motDePasse = estSecretChiffre(reglages.bindMotDePasse)
      ? dechiffrerSecret(this.cleMaitre(), reglages.bindMotDePasse)
      : '';
    return this.fabriquerAnnuaire(reglages, motDePasse);
  }

  private async valider(
    reglages: MajReglagesAnnuaireRequest['reglages'],
  ): Promise<Omit<AnnuaireEnBase, 'bindMotDePasse'>> {
    if (reglages.actif && (!reglages.url || !reglages.baseDn || !reglages.bindDn)) {
      throw new BadRequestException(
        'Un annuaire actif exige une url, une base DN et un compte de liaison.',
      );
    }
    if (!reglages.filtre.includes('{login}')) {
      // Sans `{login}`, le filtre rendrait toujours le même compte — et
      // n'importe qui entrerait sous l'identité de celui-là.
      throw new BadRequestException('Le filtre doit contenir « {login} ».');
    }
    if (reglages.synchro.intervalleHeures < 1 || reglages.synchro.intervalleHeures > 168) {
      throw new BadRequestException('Intervalle de synchronisation entre 1 et 168 heures.');
    }

    const locataires = new Set(
      (await this.prisma.tenant.findMany({ select: { id: true } })).map((t) => t.id),
    );
    for (const regle of reglages.regles) {
      if (regle.groupeDn.trim() === '') {
        throw new BadRequestException('Une règle sans groupe n’ouvre rien.');
      }
      if (!locataires.has(regle.tenantId)) {
        throw new BadRequestException(`Locataire inconnu dans une règle : ${regle.tenantId}.`);
      }
    }

    return {
      actif: reglages.actif,
      url: vide(reglages.url),
      startTls: reglages.startTls,
      verifierCertificat: reglages.verifierCertificat,
      acPem: vide(reglages.acPem),
      baseDn: vide(reglages.baseDn),
      bindDn: vide(reglages.bindDn),
      filtre: reglages.filtre,
      attributs: reglages.attributs,
      regles: reglages.regles.map((r) => ({ ...r, groupeDn: r.groupeDn.trim() })),
      synchro: reglages.synchro,
    };
  }
}

function vide(valeur: string | null): string | null {
  const propre = valeur?.trim() ?? '';
  return propre === '' ? null : propre;
}

/** Le détail d'audit d'une synchronisation, pour les tests et l'écran d'état. */
export type DetailSynchro = Prisma.InputJsonValue;
