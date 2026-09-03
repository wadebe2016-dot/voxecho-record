import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Role } from '@prisma/client';
import { RolesGuard } from '../src/common/guards/roles.guard';
import { TenantGuard } from '../src/common/guards/tenant.guard';
import { ROLES_KEY } from '../src/common/decorators/roles.decorator';
import { ADMIN_INSTANCE_KEY } from '../src/common/decorators/admin-instance.decorator';
import type { AuthUser } from '../src/auth/auth.types';

const AUDITEUR: AuthUser = {
  userId: 'u-1',
  tenantId: 't-banque',
  email: 'auditeur@a.cm',
  role: 'AUDITOR',
  instanceAdmin: false,
};

function contexte(requete: Record<string, unknown>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => requete }),
    getHandler: () => undefined,
    getClass: () => undefined,
  } as unknown as ExecutionContext;
}

function reflectorAvecRoles(roles: Role[] | undefined): Reflector {
  const reflector = new Reflector();
  jest
    .spyOn(reflector, 'getAllAndOverride')
    .mockImplementation((key) => (key === ROLES_KEY ? roles : undefined) as never);
  return reflector;
}

describe('garde des rôles', () => {
  it('laisse passer une route sans annotation de rôle', () => {
    const guard = new RolesGuard(reflectorAvecRoles(undefined));
    expect(guard.canActivate(contexte({ user: AUDITEUR }))).toBe(true);
  });

  it('laisse passer un rôle autorisé', () => {
    const guard = new RolesGuard(reflectorAvecRoles(['AUDITOR', 'ADMIN']));
    expect(guard.canActivate(contexte({ user: AUDITEUR }))).toBe(true);
  });

  it('refuse un rôle insuffisant', () => {
    const guard = new RolesGuard(reflectorAvecRoles(['ADMIN']));
    expect(() => guard.canActivate(contexte({ user: AUDITEUR }))).toThrow(ForbiddenException);
  });

  it('refuse une requête sans identité alors qu’un rôle est exigé', () => {
    const guard = new RolesGuard(reflectorAvecRoles(['ADMIN']));
    expect(() => guard.canActivate(contexte({}))).toThrow(ForbiddenException);
  });
});

describe('garde de cloisonnement', () => {
  const guard = new TenantGuard();

  it('laisse passer une requête sans revendication de locataire', () => {
    expect(guard.canActivate(contexte({ user: AUDITEUR, params: {}, query: {}, body: {} }))).toBe(
      true,
    );
  });

  it('laisse passer une revendication conforme au jeton', () => {
    expect(
      guard.canActivate(
        contexte({ user: AUDITEUR, params: { tenantId: 't-banque' }, query: {}, body: {} }),
      ),
    ).toBe(true);
  });

  it.each([
    ['le paramètre de route', { params: { tenantId: 't-autre' }, query: {}, body: {} }],
    ['la chaîne de requête', { params: {}, query: { tenantId: 't-autre' }, body: {} }],
    ['le corps de requête', { params: {}, query: {}, body: { tenantId: 't-autre' } }],
  ])('refuse un autre locataire revendiqué dans %s', (_libelle, requete) => {
    expect(() => guard.canActivate(contexte({ user: AUDITEUR, ...requete }))).toThrow(
      ForbiddenException,
    );
  });

  it('ne cloisonne pas une route publique (aucune identité)', () => {
    expect(guard.canActivate(contexte({ params: {}, query: {}, body: {} }))).toBe(true);
  });

  describe('administration de l’instance', () => {
    /** Reflector qui répond comme si `@AdminInstance()` était posé. */
    function reflectorInstance(): Reflector {
      return {
        getAllAndOverride: (cle: string) => (cle === ADMIN_INSTANCE_KEY ? true : undefined),
      } as unknown as Reflector;
    }

    it('refuse un ADMIN de locataire qui n’administre pas l’instance', () => {
      // Le cœur du §9.22 : administrer sa banque n'est pas administrer
      // l'instance qui héberge toutes les banques.
      const garde = new RolesGuard(reflectorInstance());
      const adminLocataire: AuthUser = { ...AUDITEUR, role: 'ADMIN', instanceAdmin: false };

      expect(() => garde.canActivate(contexte({ user: adminLocataire }))).toThrow(
        ForbiddenException,
      );
    });

    it('laisse passer l’administrateur de l’instance', () => {
      const garde = new RolesGuard(reflectorInstance());
      const adminInstance: AuthUser = { ...AUDITEUR, role: 'ADMIN', instanceAdmin: true };

      expect(garde.canActivate(contexte({ user: adminInstance }))).toBe(true);
    });

    it('refuse une requête sans identité', () => {
      const garde = new RolesGuard(reflectorInstance());
      expect(() => garde.canActivate(contexte({}))).toThrow(ForbiddenException);
    });
  });
});
