/* eslint-disable @typescript-eslint/unbound-method --
 * These tests read decorator metadata off the prototype, which means
 * deliberately referencing handlers as values. Nothing is ever called, so the
 * `this`-scoping hazard the rule guards against cannot occur.
 */
import { Reflector } from '@nestjs/core';
import { Role } from '@prisma/client';
import { ProductsController } from './products.controller';
import { ProductsService } from './products.service';
import { ROLES_KEY } from '../auth/decorators/roles.decorator';
import { IS_PUBLIC_KEY } from '../auth/decorators/public.decorator';

/** A controller method referenced as a value, for reading its metadata. */
type Handler = (...args: never[]) => unknown;

/**
 * BUG-002 — the admin dashboard reads the catalogue through the *storefront*
 * endpoints, which are hard-wired to active-only. A deactivated product then
 * disappears from the admin list AND its detail page 404s, so nothing can ever
 * reactivate it. These cover the admin-only routes that close that dead end.
 */
describe('ProductsController (admin routes)', () => {
  let products: {
    list: jest.Mock;
    listAdmin: jest.Mock;
    suggest: jest.Mock;
    getBySlug: jest.Mock;
    getForAdmin: jest.Mock;
  };
  let controller: ProductsController;

  beforeEach(() => {
    products = {
      list: jest.fn().mockResolvedValue({ items: [] }),
      listAdmin: jest.fn().mockResolvedValue({ items: [] }),
      suggest: jest.fn().mockResolvedValue({ products: [], suggestions: [] }),
      getBySlug: jest.fn().mockResolvedValue({ id: 'p1' }),
      getForAdmin: jest.fn().mockResolvedValue({ id: 'p1', isActive: false }),
    };
    controller = new ProductsController(products as unknown as ProductsService);
  });

  it('routes the admin listing to listAdmin (inactive products included)', async () => {
    await controller.adminList({ page: 1, pageSize: 20, status: 'all' });
    expect(products.listAdmin).toHaveBeenCalledWith({
      page: 1,
      pageSize: 20,
      status: 'all',
    });
    // The storefront (active-only) listing must NOT serve admin reads.
    expect(products.list).not.toHaveBeenCalled();
  });

  it('resolves an inactive product by id or slug for admins', async () => {
    const found = await controller.adminDetail('atta');
    expect(products.getForAdmin).toHaveBeenCalledWith('atta');
    expect(found).toEqual({ id: 'p1', isActive: false });
    expect(products.getBySlug).not.toHaveBeenCalled();
  });

  it('keeps the storefront listing active-only', async () => {
    await controller.list({ page: 1, pageSize: 20 });
    expect(products.list).toHaveBeenCalledWith(
      { page: 1, pageSize: 20 },
      false,
    );
  });

  /**
   * Guards are global (auth.module), so constructing the controller directly
   * bypasses them — these assert the metadata itself, so deleting a @Roles or
   * flipping a route to @Public fails a test instead of silently opening the
   * admin catalogue to the world.
   */
  describe('route guards', () => {
    const reflector = new Reflector();
    const roles = (h: Handler) => reflector.get(ROLES_KEY, h);
    const isPublic = (h: Handler) => reflector.get(IS_PUBLIC_KEY, h);
    const admin = [Role.ADMIN, Role.SUPERADMIN];

    it.each<[string, Handler]>([
      ['adminList', ProductsController.prototype.adminList],
      ['adminDetail', ProductsController.prototype.adminDetail],
      ['create', ProductsController.prototype.create],
      ['update', ProductsController.prototype.update],
      ['setActive', ProductsController.prototype.setActive],
      ['remove', ProductsController.prototype.remove],
    ])('%s is ADMIN/SUPERADMIN only', (_name, handler) => {
      expect(roles(handler)).toEqual(admin);
      expect(isPublic(handler)).toBeUndefined();
    });

    it.each<[string, Handler]>([
      ['list', ProductsController.prototype.list],
      ['bySlug', ProductsController.prototype.bySlug],
      ['related', ProductsController.prototype.related],
    ])('%s stays public', (_name, handler) => {
      expect(isPublic(handler)).toBe(true);
      expect(roles(handler)).toBeUndefined();
    });
  });
});
