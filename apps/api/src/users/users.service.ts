import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { User } from '@prisma/client';
import type { TemporaryPasswordResponse, UserSummary } from '@voxecho/shared';
import { AuditService } from '../audit/audit.service';
import { AppConfig } from '../config/config.module';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthUser } from '../auth/auth.types';
import { hashPassword } from '../auth/password';
import { motDePasseProvisoire } from '../auth/password-policy';
import type { CreateUserDto } from './dto/create-user.dto';
import type { UpdateUserDto } from './dto/update-user.dto';

/**
 * Gestion des comptes d'un locataire — CLAUDE.md §9.26.
 *
 * Donner à quelqu'un le droit d'entendre des conversations de clients est
 * l'acte le plus lourd de cette console : chaque changement s'inscrit au
 * journal avec son avant et son après.
 */
@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly config: AppConfig,
  ) {}

  private versResume(compte: User): UserSummary {
    return {
      id: compte.id,
      email: compte.email,
      role: compte.role,
      active: compte.active,
      instanceAdmin: compte.instanceAdmin,
      mustChangePassword: compte.mustChangePassword,
      lastLoginAt: compte.lastLoginAt?.toISOString() ?? null,
      lockedUntil: compte.lockedUntil?.toISOString() ?? null,
      createdAt: compte.createdAt.toISOString(),
    };
  }

  async lister(tenantId: string): Promise<UserSummary[]> {
    const comptes = await this.prisma.user.findMany({
      where: { tenantId },
      orderBy: [{ active: 'desc' }, { email: 'asc' }],
    });
    return comptes.map((compte) => this.versResume(compte));
  }

  /** Le compte visé, s'il appartient bien au locataire du demandeur. */
  private async exigerCompte(tenantId: string, id: string): Promise<User> {
    const compte = await this.prisma.user.findFirst({ where: { id, tenantId } });
    if (!compte) throw new NotFoundException('Compte introuvable.');
    return compte;
  }

  async creer(
    user: AuthUser,
    dto: CreateUserDto,
    ip: string | null,
  ): Promise<TemporaryPasswordResponse> {
    const email = dto.email.trim().toLowerCase();
    const existant = await this.prisma.user.findUnique({ where: { email } });
    if (existant) {
      // L'unicité est globale (§9.1) : on ne dit pas chez quel locataire
      // l'adresse est déjà prise, mais on doit bien refuser.
      throw new ConflictException('Cette adresse est déjà utilisée.');
    }

    const provisoire = motDePasseProvisoire();
    const compte = await this.prisma.user.create({
      data: {
        tenantId: user.tenantId,
        email,
        role: dto.role,
        passwordHash: await hashPassword(provisoire),
        // Le mot de passe est passé par les mains d'un administrateur : il ne
        // doit pas survivre à la première connexion (§9.26).
        mustChangePassword: true,
      },
    });

    await this.audit.record({
      tenantId: user.tenantId,
      userId: user.userId,
      action: 'USER_SET',
      ip,
      detail: { acte: 'creation', cible: email, role: dto.role },
    });

    return { compte: this.versResume(compte), motDePasseProvisoire: provisoire };
  }

  async modifier(
    user: AuthUser,
    id: string,
    dto: UpdateUserDto,
    ip: string | null,
  ): Promise<UserSummary> {
    const compte = await this.exigerCompte(user.tenantId, id);

    if (dto.role === undefined && dto.active === undefined) {
      throw new BadRequestException('Rien à modifier.');
    }

    if (compte.id === user.userId) {
      // Se rétrograder ou se désactiver soi-même, c'est se fermer la porte
      // depuis l'intérieur : il faudrait alors un accès au serveur pour
      // revenir. Un autre administrateur peut le faire.
      throw new BadRequestException(
        'Un administrateur ne modifie pas son propre compte : demandez-le à un autre administrateur.',
      );
    }

    const perdSonRole = dto.role !== undefined && dto.role !== 'ADMIN' && compte.role === 'ADMIN';
    const seraDesactive = dto.active === false && compte.active;
    if (compte.instanceAdmin && (perdSonRole || seraDesactive)) {
      await this.exigerUnAutreAdministrateurDInstance(compte.id);
    }

    const modifie = await this.prisma.user.update({
      where: { id: compte.id },
      data: {
        ...(dto.role === undefined ? {} : { role: dto.role }),
        ...(dto.active === undefined ? {} : { active: dto.active }),
        // Un compte réactivé ne conserve pas ses échecs de connexion : le
        // verrouillage sanctionne une salve, pas une identité.
        ...(dto.active === true ? { failedLoginAttempts: 0, lockedUntil: null } : {}),
      },
    });

    await this.audit.record({
      tenantId: user.tenantId,
      userId: user.userId,
      action: 'USER_SET',
      ip,
      detail: {
        acte: 'modification',
        cible: compte.email,
        avant: { role: compte.role, active: compte.active },
        apres: { role: modifie.role, active: modifie.active },
      },
    });

    return this.versResume(modifie);
  }

  /**
   * Réinitialise le mot de passe d'un compte : nouveau provisoire, à
   * renouveler à la première connexion, et sessions ouvertes révoquées.
   */
  async reinitialiser(
    user: AuthUser,
    id: string,
    ip: string | null,
  ): Promise<TemporaryPasswordResponse> {
    const compte = await this.exigerCompte(user.tenantId, id);
    const provisoire = motDePasseProvisoire();

    const modifie = await this.prisma.user.update({
      where: { id: compte.id },
      data: {
        passwordHash: await hashPassword(provisoire),
        mustChangePassword: true,
        failedLoginAttempts: 0,
        lockedUntil: null,
      },
    });
    await this.prisma.refreshToken.updateMany({
      where: { userId: compte.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    await this.audit.record({
      tenantId: user.tenantId,
      userId: user.userId,
      action: 'USER_SET',
      ip,
      detail: { acte: 'reinitialisation', cible: compte.email },
    });

    return { compte: this.versResume(modifie), motDePasseProvisoire: provisoire };
  }

  /**
   * Refuse de retirer le dernier administrateur de l'instance — réserve du
   * §9.22. Sans lui, la console d'administration se ferme à tout le monde et
   * il faut un accès au serveur pour la rouvrir.
   */
  private async exigerUnAutreAdministrateurDInstance(sauf: string): Promise<void> {
    const autres = await this.prisma.user.count({
      where: { instanceAdmin: true, active: true, id: { not: sauf } },
    });
    if (autres === 0) {
      throw new BadRequestException(
        'Dernier administrateur de l’instance : en désigner un autre avant de retirer celui-ci.',
      );
    }
  }

  /** Longueur minimale exigée, pour que le portail l'annonce avant l'échec. */
  get longueurMinimale(): number {
    return this.config.get('PASSWORD_MIN_LENGTH');
  }
}
