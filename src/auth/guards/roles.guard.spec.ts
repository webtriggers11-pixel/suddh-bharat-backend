import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Role } from '@prisma/client';
import { RolesGuard } from './roles.guard';

function ctx(user: { roles: Role[] } | undefined): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
    getHandler: () => undefined,
    getClass: () => undefined,
  } as unknown as ExecutionContext;
}

describe('RolesGuard', () => {
  const make = (required: Role[] | undefined) => {
    const reflector = {
      getAllAndOverride: () => required,
    } as unknown as Reflector;
    return new RolesGuard(reflector);
  };

  it('allows when no roles are required', () => {
    expect(make(undefined).canActivate(ctx({ roles: [Role.USER] }))).toBe(true);
  });

  it('allows when the user has one of the required roles', () => {
    const guard = make([Role.ADMIN, Role.SUPERADMIN]);
    expect(guard.canActivate(ctx({ roles: [Role.ADMIN] }))).toBe(true);
  });

  it('forbids when the user lacks every required role', () => {
    const guard = make([Role.ADMIN]);
    expect(() => guard.canActivate(ctx({ roles: [Role.USER] }))).toThrow(
      ForbiddenException,
    );
  });

  it('forbids when there is no authenticated user', () => {
    expect(() => make([Role.USER]).canActivate(ctx(undefined))).toThrow(
      ForbiddenException,
    );
  });
});
