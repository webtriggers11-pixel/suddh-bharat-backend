import { ProductsController } from './products.controller';
import { ProductsService } from './products.service';

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
});
