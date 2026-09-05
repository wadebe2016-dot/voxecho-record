import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import type { User } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { AppConfig } from '../config/config.module';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthUser, TokenPair } from './auth.types';
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
  ) {}

  async login(email: string, password: string, ip: string | null): Promise<TokenPair> {
    const normalise = email.trim().toLowerCase();
    const user = await this.prisma.user.findUnique({ where: { email: normalise } });

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
