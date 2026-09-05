import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import type { User } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { AppConfig } from '../config/config.module';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthUser, TokenPair } from './auth.types';
import { AnnuaireService } from '../settings/annuaire.service';
import { ReseauService } from '../settings/reseau.service';
import { LimitationConnexion } from './limitation-connexion.service';
import { hashPassword, verifyPassword } from './password';
import { verifierMotDePasse } from './password-policy';
import { TokensService } from './tokens.service';

/**
 * Hachage factice, comparé lorsque l'adresse est inconnue : le temps de
 * réponse ne doit pas révéler l'existence d'un compte.
 */
const LEURRE = hashPassword('mot-de-passe-inexistant');

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokensService,
    private readonly audit: AuditService,
    private readonly config: AppConfig,
    private readonly limitation: LimitationConnexion,
    private readonly reseau: ReseauService,
    private readonly annuaire: AnnuaireService,
  ) {}

  /**
   * Connexion hybride — CLAUDE.md §9.37.
   *
   * L'écran de connexion reste unique. L'annuaire est tenté d'abord quand il
   * est actif ; le repli local ne vaut que pour les comptes `source=local`.
   * Un compte d'annuaire n'a pas de mot de passe local : il ne peut donc pas
   * entrer par la porte locale, même si l'annuaire est éteint.
   */
  async login(email: string, password: string, ip: string | null): Promise<TokenPair> {
    const normalise = email.trim().toLowerCase();

    const user = await this.prisma.user.findUnique({ where: { email: normalise } });
    // Une porte locale existe-t-elle pour cette adresse ? C'est ce qui décide
    // si un refus de l'annuaire est définitif ou s'il laisse essayer l'autre.
    const porteLocale = user !== null && user.source === 'local' && user.passwordHash !== null;

    const parAnnuaire = await this.tenterAnnuaire(normalise, password, ip, porteLocale);
    if (parAnnuaire !== null) return parAnnuaire;

    if (!user) {
      await verifyPassword(await LEURRE, password);
      // Rien au journal d'audit : une adresse inconnue n'a ni compte ni
      // locataire, et tracer chaque tentative offrirait à un inconnu le moyen
      // de gonfler à volonté un journal que rien ne peut purger. C'est le
      // blocage qui s'inscrit, une fois par épisode (§9.16).
      this.limitation.signalerEchec(ip);
      this.logger.warn(`Échec de connexion : adresse inconnue (${normalise})`);
      throw new UnauthorizedException('Identifiants invalides.');
    }

    if (this.estVerrouille(user)) {
      await this.audit.record({
        tenantId: user.tenantId,
        userId: user.id,
        action: 'LOGIN',
        ip,
        detail: { resultat: 'verrouille', email: normalise },
      });
      this.limitation.signalerEchec(ip);
      throw new ForbiddenException(
        'Compte temporairement verrouillé après plusieurs échecs de connexion.',
      );
    }

    if (user.passwordHash === null) {
      // Compte d'annuaire : il n'a pas de mot de passe local, et lui en
      // inventer un ouvrirait une porte que l'annuaire ne saurait pas fermer.
      await verifyPassword(await LEURRE, password);
      await this.audit.record({
        tenantId: user.tenantId,
        userId: user.id,
        action: 'LOGIN',
        ip,
        detail: { resultat: 'annuaire_indisponible', email: normalise },
      });
      this.limitation.signalerEchec(ip);
      throw new UnauthorizedException(
        'Ce compte est géré par l’annuaire, momentanément injoignable. Réessayez plus tard.',
      );
    }

    const motDePasseValide = await verifyPassword(user.passwordHash, password);

    if (!motDePasseValide) {
      const verrouille = await this.enregistrerEchec(user);
      await this.audit.record({
        tenantId: user.tenantId,
        userId: user.id,
        action: 'LOGIN',
        ip,
        detail: { resultat: verrouille ? 'verrouillage' : 'echec', email: normalise },
      });
      this.limitation.signalerEchec(ip);
      throw new UnauthorizedException('Identifiants invalides.');
    }

    if (!user.active) {
      await this.audit.record({
        tenantId: user.tenantId,
        userId: user.id,
        action: 'LOGIN',
        ip,
        detail: { resultat: 'compte_desactive', email: normalise },
      });
      this.limitation.signalerEchec(ip);
      throw new ForbiddenException('Compte désactivé.');
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: { failedLoginAttempts: 0, lockedUntil: null, lastLoginAt: new Date() },
    });

    const identite = this.identite(user);
    const paire = await this.tokens.issue(identite);

    await this.audit.record({
      tenantId: user.tenantId,
      userId: user.id,
      action: 'LOGIN',
      ip,
      detail: { resultat: 'succes', email: normalise, role: user.role },
    });

    return paire;
  }

  /**
   * Tente l'annuaire — CLAUDE.md §9.37.
   *
   * Rend `null` quand la porte locale doit se prononcer à sa place. Deux cas
   * en dépendent, et ils décident du sort de l'instance le jour d'une panne :
   *
   * — **mot de passe refusé** : la même adresse peut exister des deux côtés
   *   avec deux mots de passe différents. Ce n'est pas offrir deux chances à
   *   la même porte, c'est en avoir deux, ce qu'un mode hybride suppose. La
   *   limitation par adresse compte l'échec de toute façon (§9.16).
   * — **annuaire injoignable** : un compte local doit continuer d'entrer,
   *   sans quoi une panne de l'annuaire fermerait la console à tout le monde —
   *   et l'invariant du dernier administrateur local ne servirait à rien.
   *
   * Les deux refus qui restent sont définitifs : aucun groupe mappé, et une
   * adresse que possède déjà un compte local.
   */
  private async tenterAnnuaire(
    email: string,
    password: string,
    ip: string | null,
    porteLocale: boolean,
  ): Promise<TokenPair | null> {
    const login = email.includes('@') ? (email.split('@')[0] as string) : email;
    const verdict = await this.annuaire.authentifier(login, password, ip);

    switch (verdict.issue) {
      case 'inactif':
      case 'introuvable':
        return null;

      case 'identifiants':
        if (porteLocale) return null;
        this.limitation.signalerEchec(ip);
        throw new UnauthorizedException('Identifiants invalides.');

      case 'injoignable':
        if (porteLocale) return null;
        this.limitation.signalerEchec(ip);
        throw new ServiceUnavailableException(
          'Annuaire momentanément injoignable : les connexions par annuaire sont suspendues.',
        );

      case 'non_mappe':
        this.limitation.signalerEchec(ip);
        throw new ForbiddenException(
          'Aucun groupe de cet annuaire ne donne accès à VoxEcho Record.',
        );

      case 'conflit_local':
        this.limitation.signalerEchec(ip);
        throw new ForbiddenException(
          'Un compte local porte déjà cette adresse. Un administrateur doit le rattacher à l’annuaire avant que cette connexion soit possible.',
        );

      case 'admis': {
        const identite = this.identite(verdict.compte);
        const paire = await this.tokens.issue(identite);
        await this.prisma.user.update({
          where: { id: verdict.compte.id },
          data: { lastLoginAt: new Date() },
        });
        await this.audit.record({
          tenantId: verdict.compte.tenantId,
          userId: verdict.compte.id,
          action: 'LOGIN',
          ip,
          detail: {
            resultat: 'succes',
            email: verdict.compte.email,
            role: verdict.compte.role,
            source: 'annuaire',
            ...(verdict.cree ? { compteCree: true } : {}),
          },
        });
        return paire;
      }
    }
  }

  /** Rotation : l'ancien jeton est révoqué dès qu'un nouveau est émis. */
  async refresh(refreshToken: string): Promise<TokenPair> {
    const { payload, storedId } = await this.tokens.verifyRefresh(refreshToken);
    const user = await this.prisma.user.findUnique({ where: { id: payload.sub } });

    if (!user || !user.active || user.tenantId !== payload.tid) {
      await this.tokens.revoke(storedId);
      throw new UnauthorizedException('Session close.');
    }

    await this.tokens.revoke(storedId);
    return this.tokens.issue(this.identite(user));
  }

  async logout(refreshToken: string | undefined, user: AuthUser): Promise<void> {
    if (refreshToken) {
      const stored = await this.prisma.refreshToken.findUnique({
        where: { tokenHash: TokensService.fingerprint(refreshToken) },
      });
      if (stored && stored.userId === user.userId) {
        await this.tokens.revoke(stored.id);
        return;
      }
    }
    await this.tokens.revokeAllForUser(user.userId);
  }

  async profil(user: AuthUser): Promise<{
    id: string;
    email: string;
    role: string;
    tenantId: string;
    tenantName: string;
    instanceAdmin: boolean;
    mustChangePassword: boolean;
    fuseau: string;
  }> {
    const compte = await this.prisma.user.findFirst({
      where: { id: user.userId, tenantId: user.tenantId },
      include: { tenant: { select: { name: true } } },
    });
    if (!compte || !compte.active) {
      throw new UnauthorizedException('Session close.');
    }
    return {
      id: compte.id,
      email: compte.email,
      role: compte.role,
      tenantId: compte.tenantId,
      tenantName: compte.tenant.name,
      // Le fuseau d'affichage vient de l'instance (§9.36) : le portail formate
      // toutes ses dates avec, et ne saurait pas seul dans quel fuseau
      // présenter l'heure d'un appel.
      fuseau: await this.reseau.fuseau(),
      // Relu en base, non repris du jeton : une révocation prononcée pendant
      // une session doit se voir au prochain chargement du portail.
      instanceAdmin: compte.instanceAdmin,
      mustChangePassword: compte.mustChangePassword,
    };
  }

  /**
   * Changement de mot de passe par son titulaire — CLAUDE.md §9.26.
   *
   * Rend une paire de jetons neuve : le drapeau « à renouveler » voyage dans
   * le jeton, et sans cela le compte resterait bloqué jusqu'à son expiration.
   * Les sessions ouvertes ailleurs sont révoquées — changer son mot de passe
   * est le geste de qui craint qu'on le lui ait pris.
   */
  async changerMotDePasse(
    user: AuthUser,
    ancien: string,
    nouveau: string,
    ip: string | null,
  ): Promise<TokenPair> {
    const compte = await this.prisma.user.findFirst({
      where: { id: user.userId, tenantId: user.tenantId },
    });
    if (!compte || !compte.active) throw new UnauthorizedException('Session close.');

    if (compte.passwordHash === null) {
      throw new BadRequestException(
        'Ce compte est géré par l’annuaire : son mot de passe se change dans l’annuaire.',
      );
    }
    if (!(await verifyPassword(compte.passwordHash, ancien))) {
      this.limitation.signalerEchec(ip);
      throw new UnauthorizedException('Mot de passe actuel incorrect.');
    }
    if (ancien === nouveau) {
      throw new BadRequestException({
        message: 'Nouveau mot de passe refusé.',
        details: ['Le nouveau mot de passe doit différer de l’actuel.'],
      });
    }

    const verdict = verifierMotDePasse(nouveau, {
      longueurMinimale: this.config.get('PASSWORD_MIN_LENGTH'),
      email: compte.email,
    });
    if (!verdict.ok) {
      throw new BadRequestException({
        message: 'Nouveau mot de passe refusé.',
        details: verdict.erreurs,
      });
    }

    await this.prisma.user.update({
      where: { id: compte.id },
      data: { passwordHash: await hashPassword(nouveau), mustChangePassword: false },
    });
    await this.tokens.revokeAllForUser(compte.id);

    await this.audit.record({
      tenantId: compte.tenantId,
      userId: compte.id,
      action: 'USER_SET',
      ip,
      detail: { acte: 'mot_de_passe_change', cible: compte.email, parSonTitulaire: true },
    });

    return this.tokens.issue({ ...this.identite(compte), mustChangePassword: false });
  }

  private identite(user: User): AuthUser {
    return {
      userId: user.id,
      tenantId: user.tenantId,
      email: user.email,
      role: user.role,
      instanceAdmin: user.instanceAdmin,
      mustChangePassword: user.mustChangePassword,
    };
  }

  private estVerrouille(user: User): boolean {
    return user.lockedUntil !== null && user.lockedUntil.getTime() > Date.now();
  }

  /** Incrémente le compteur d'échecs et verrouille au seuil. */
  private async enregistrerEchec(user: User): Promise<boolean> {
    const seuil = this.config.get('AUTH_MAX_FAILED_ATTEMPTS');
    const dureeMin = this.config.get('AUTH_LOCK_DURATION_MIN');
    const tentatives = user.failedLoginAttempts + 1;

    if (tentatives >= seuil) {
      await this.prisma.user.update({
        where: { id: user.id },
        data: {
          failedLoginAttempts: 0,
          lockedUntil: new Date(Date.now() + dureeMin * 60_000),
        },
      });
      await this.tokens.revokeAllForUser(user.id);
      this.logger.warn(`Compte verrouillé ${dureeMin} min après ${seuil} échecs : ${user.email}`);
      return true;
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: { failedLoginAttempts: tentatives },
    });
    return false;
  }
}
