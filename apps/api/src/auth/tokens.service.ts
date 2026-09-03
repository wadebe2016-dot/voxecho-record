import { createHash, randomUUID } from 'node:crypto';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AppConfig } from '../config/config.module';
import { PrismaService } from '../prisma/prisma.service';
import type { AccessTokenPayload, AuthUser, RefreshTokenPayload, TokenPair } from './auth.types';

/**
 * Fabrique et vérifie les jetons. Le jeton de rafraîchissement est signé
 * (JWT) *et* son empreinte est stockée en base : il reste révocable, et il
 * est renouvelé à chaque usage (rotation).
 */
@Injectable()
export class TokensService {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: AppConfig,
    private readonly prisma: PrismaService,
  ) {}

  /** Empreinte stockée : le jeton lui-même n'est jamais conservé en clair. */
  static fingerprint(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  async issue(user: AuthUser): Promise<TokenPair> {
    const accessPayload: AccessTokenPayload = {
      sub: user.userId,
      tid: user.tenantId,
      email: user.email,
      role: user.role,
      adm: user.instanceAdmin,
    };
    const accessToken = await this.jwt.signAsync(accessPayload, {
      secret: this.config.get('JWT_ACCESS_SECRET'),
      expiresIn: this.config.get('JWT_ACCESS_TTL'),
    });

    const refreshPayload: RefreshTokenPayload = { sub: user.userId, tid: user.tenantId };
    const refreshToken = await this.jwt.signAsync(refreshPayload, {
      secret: this.config.get('JWT_REFRESH_SECRET'),
      expiresIn: this.config.get('JWT_REFRESH_TTL'),
      jwtid: randomUUID(),
    });

    await this.prisma.refreshToken.create({
      data: {
        tenantId: user.tenantId,
        userId: user.userId,
        tokenHash: TokensService.fingerprint(refreshToken),
        expiresAt: this.expiryOf(refreshToken),
      },
    });

    return { accessToken, refreshToken, expiresIn: this.config.get('JWT_ACCESS_TTL') };
  }

  async verifyAccess(token: string): Promise<AuthUser> {
    try {
      const payload = await this.jwt.verifyAsync<AccessTokenPayload>(token, {
        secret: this.config.get('JWT_ACCESS_SECRET'),
      });
      return {
        userId: payload.sub,
        tenantId: payload.tid,
        email: payload.email,
        role: payload.role,
        // Absent des jetons émis avant le §9.22 : sans le drapeau, on
        // n'accorde rien. Un privilège ne se déduit jamais d'un silence.
        instanceAdmin: payload.adm === true,
      };
    } catch {
      throw new UnauthorizedException('Jeton invalide ou expiré.');
    }
  }

  /**
   * Vérifie un jeton de rafraîchissement : signature valide, empreinte connue,
   * non révoquée, non expirée. Rend l'identifiant de l'entrée en base.
   */
  async verifyRefresh(token: string): Promise<{ payload: RefreshTokenPayload; storedId: string }> {
    let payload: RefreshTokenPayload;
    try {
      payload = await this.jwt.verifyAsync<RefreshTokenPayload>(token, {
        secret: this.config.get('JWT_REFRESH_SECRET'),
      });
    } catch {
      throw new UnauthorizedException('Jeton de rafraîchissement invalide ou expiré.');
    }

    const stored = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: TokensService.fingerprint(token) },
    });
    if (!stored || stored.revokedAt !== null || stored.expiresAt.getTime() <= Date.now()) {
      throw new UnauthorizedException('Jeton de rafraîchissement invalide ou expiré.');
    }
    if (stored.userId !== payload.sub || stored.tenantId !== payload.tid) {
      throw new UnauthorizedException('Jeton de rafraîchissement invalide ou expiré.');
    }

    return { payload, storedId: stored.id };
  }

  async revoke(storedId: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { id: storedId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  /** Révoque toutes les sessions d'un compte (déconnexion, désactivation). */
  async revokeAllForUser(userId: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  private expiryOf(token: string): Date {
    const decoded = this.jwt.decode(token) as { exp?: number } | null;
    if (!decoded?.exp) {
      throw new Error('Jeton de rafraîchissement sans échéance.');
    }
    return new Date(decoded.exp * 1000);
  }
}
