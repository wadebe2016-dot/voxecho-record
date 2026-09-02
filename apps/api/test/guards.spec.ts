import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Role } from '@prisma/client';
import { RolesGuard } from '../src/common/guards/roles.guard';
import { TenantGuard } from '../src/common/guards/tenant.guard';
import { ROLES_KEY } from '../src/common/decorators/roles.decorator';
import type { AuthUser } from '../src/auth/auth.types';

const AUDITEUR: AuthUser = {
  userId: 'u-1',
  tenantId: 't-banque',
  email: 'auditeur@a.cm',
  role: 'AUDITOR',
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
    ['paramètre de route', { params: { tenantId: 't-autre' }, query: {}, body: {} }],
    ['chaîne de requête', { params: {}, query: { tenantId: 't-autre' }, body: {} }],
    ['corps de requête', { params: {}, query: {}, body: { tenantId: 't-autre' } }],
  ])('refuse un autre locataire revendiqué dans le %s', (_libelle, requete) => {
    expect(() => guard.canActivate(contexte({ user: AUDITEUR, ...requete }))).toThrow(
      ForbiddenException,
    );
  });

  it('ne cloisonne pas une route publique (aucune identité)', () => {
    expect(guard.canActivate(contexte({ params: {}, query: {}, body: {} }))).toBe(true);
  });
});
