/* eslint-disable @typescript-eslint/unbound-method --
 * These tests read decorator metadata off the prototype, which means
 * deliberately referencing handlers as values. Nothing is ever called, so the
 * `this`-scoping hazard the rule guards against cannot occur.
 */
import { Reflector } from '@nestjs/core';
import { Role } from '@prisma/client';
import { ReviewsController } from './reviews.controller';
import { ROLES_KEY } from '../auth/decorators/roles.decorator';
import { IS_PUBLIC_KEY } from '../auth/decorators/public.decorator';

/** A controller method referenced as a value, for reading its metadata. */
type Handler = (...args: never[]) => unknown;

/**
 * Guards are global (auth.module), so these assert the metadata directly —
 * losing a @Roles here would let any signed-in shopper publish or delete other
 * people's reviews.
 */
describe('ReviewsController route guards (FEAT-024)', () => {
  const reflector = new Reflector();
  const roles = (h: Handler) => reflector.get(ROLES_KEY, h);
  const isPublic = (h: Handler) => reflector.get(IS_PUBLIC_KEY, h);
  const admin = [Role.ADMIN, Role.SUPERADMIN];

  it.each<[string, Handler]>([
    ['adminList', ReviewsController.prototype.adminList],
    ['approve', ReviewsController.prototype.approve],
    ['setApproved', ReviewsController.prototype.setApproved],
    ['adminRemove', ReviewsController.prototype.adminRemove],
  ])('%s is ADMIN/SUPERADMIN only', (_name, handler) => {
    expect(roles(handler)).toEqual(admin);
    expect(isPublic(handler)).toBeUndefined();
  });

  it('only the per-product read is public', () => {
    expect(isPublic(ReviewsController.prototype.forProduct)).toBe(true);
    expect(isPublic(ReviewsController.prototype.mine)).toBeUndefined();
    expect(isPublic(ReviewsController.prototype.create)).toBeUndefined();
    expect(isPublic(ReviewsController.prototype.remove)).toBeUndefined();
  });

  // The owner-only delete must not have picked up admin rights.
  it('leaves the owner-only delete without a role requirement', () => {
    expect(roles(ReviewsController.prototype.remove)).toBeUndefined();
  });
});
