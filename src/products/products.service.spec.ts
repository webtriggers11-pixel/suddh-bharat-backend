import { ConflictException, NotFoundException } from '@nestjs/common';
import { Product } from '@prisma/client';
import { ProductsService } from './products.service';
import { PrismaService } from '../prisma/prisma.service';

function makeProduct(over: Partial<Product> = {}): Product {
  return {
    id: 'p1',
    name: 'Atta',
    slug: 'atta',
    description: null,
    priceMinor: 34900,
    mrpMinor: 42000,
    stock: 10,
    images: [],
    categoryId: null,
    tags: [],
    collection: null,
    sku: null,
    hsnCode: null,
    material: null,
    color: null,
    weightKg: null,
    lengthCm: null,
    breadthCm: null,
    heightCm: null,
    isActive: true,
    isHandmade: true,
    isFeatured: false,
    isNew: false,
    isBestseller: false,
    avgRating: 0,
    reviewCount: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    ...over,
  };
}

describe('ProductsService', () => {
  let prisma: {
    product: {
      findMany: jest.Mock;
      findFirst: jest.Mock;
      count: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
    };
    category: { findFirst: jest.Mock };
    $transaction: jest.Mock;
  };
  let service: ProductsService;

  beforeEach(() => {
    prisma = {
      product: {
        findMany: jest.fn(),
        findFirst: jest.fn(),
        count: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
      category: { findFirst: jest.fn() },
      $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
    };
    service = new ProductsService(
      prisma as unknown as PrismaService,
      {
        revalidate: jest.fn(),
      } as unknown as import('../common/revalidate.service').RevalidateService,
    );
  });

  describe('list', () => {
    it('paginates and only returns active products by default', async () => {
      prisma.product.count.mockResolvedValue(1);
      prisma.product.findMany.mockResolvedValue([makeProduct()]);
      const result = await service.list({ page: 1, pageSize: 20 }, false);

      expect(result.total).toBe(1);
      expect(result.totalPages).toBe(1);
      const findArg = prisma.product.findMany.mock.calls[0][0];
      expect(findArg.where).toMatchObject({ deletedAt: null, isActive: true });
      expect(findArg.take).toBe(20);
      expect(findArg.skip).toBe(0);
    });

    it('caps pageSize at 100', async () => {
      prisma.product.count.mockResolvedValue(0);
      prisma.product.findMany.mockResolvedValue([]);
      await service.list({ page: 1, pageSize: 999 }, false);
      expect(prisma.product.findMany.mock.calls[0][0].take).toBe(100);
    });

    it('sorts by price ascending when asked', async () => {
      prisma.product.count.mockResolvedValue(0);
      prisma.product.findMany.mockResolvedValue([]);
      await service.list({ page: 1, pageSize: 20, sort: 'price_asc' }, false);
      expect(prisma.product.findMany.mock.calls[0][0].orderBy).toEqual([
        { priceMinor: 'asc' },
        { id: 'desc' },
      ]);
    });

    it('expands a top-level categorySlug to include child categories', async () => {
      prisma.category.findFirst.mockResolvedValue({
        id: 'top',
        children: [{ id: 'sub1' }, { id: 'sub2' }],
      });
      prisma.product.count.mockResolvedValue(0);
      prisma.product.findMany.mockResolvedValue([]);
      await service.list(
        { page: 1, pageSize: 20, categorySlug: 'food' },
        false,
      );
      const where = prisma.product.findMany.mock.calls[0][0].where;
      expect(where.categoryId).toEqual({ in: ['top', 'sub1', 'sub2'] });
    });

    it('never selects sku or audit timestamps for the public listing (T8)', async () => {
      prisma.product.count.mockResolvedValue(0);
      prisma.product.findMany.mockResolvedValue([]);
      await service.list({ page: 1, pageSize: 20 }, false);
      const select = prisma.product.findMany.mock.calls[0][0].select;
      expect(select).not.toHaveProperty('sku');
      expect(select).not.toHaveProperty('createdAt');
      expect(select).not.toHaveProperty('updatedAt');
    });
  });

  describe('suggest', () => {
    it('returns empty for a search under 2 chars (no query)', async () => {
      const res = await service.suggest({ page: 1, pageSize: 6, search: 'a' });
      expect(res).toEqual({ products: [], suggestions: [] });
      expect(prisma.product.findMany).not.toHaveBeenCalled();
    });

    it('maps matches to {products, suggestions} with first image + price', async () => {
      prisma.product.findMany.mockResolvedValue([
        makeProduct({
          id: 'p1',
          name: 'Atta',
          slug: 'atta',
          priceMinor: 34900,
          images: ['img-a', 'img-b'],
        }),
        makeProduct({ id: 'p2', name: 'Atta', slug: 'atta-2', images: [] }),
      ]);
      const res = await service.suggest({ page: 1, pageSize: 6, search: 'at' });
      expect(prisma.product.findMany.mock.calls[0][0].take).toBe(6);
      expect(res.products[0]).toEqual({
        id: 'p1',
        name: 'Atta',
        slug: 'atta',
        image: 'img-a',
        priceMinor: 34900,
      });
      expect(res.products[1].image).toBeNull();
      // suggestions are distinct names.
      expect(res.suggestions).toEqual(['Atta']);
    });
  });

  describe('getBySlug', () => {
    it('throws NotFound for a missing product', async () => {
      prisma.product.findFirst.mockResolvedValue(null);
      await expect(service.getBySlug('nope')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('findRelated', () => {
    it('returns up to 8 other active, in-stock products from the same category', async () => {
      prisma.product.findFirst.mockResolvedValue(
        makeProduct({ id: 'p1', categoryId: 'cat-1' }),
      );
      const related = [makeProduct({ id: 'p2', categoryId: 'cat-1' })];
      prisma.product.findMany.mockResolvedValue(related);

      const result = await service.findRelated('atta');

      expect(result).toBe(related);
      const findFirstArg = prisma.product.findFirst.mock.calls[0][0];
      expect(findFirstArg.where).toMatchObject({ slug: 'atta' });
      const findManyArg = prisma.product.findMany.mock.calls[0][0];
      expect(findManyArg.where).toMatchObject({
        deletedAt: null,
        isActive: true,
        categoryId: 'cat-1',
        stock: { gt: 0 },
        NOT: { id: 'p1' },
      });
      expect(findManyArg.take).toBe(8);
      expect(findManyArg.orderBy).toEqual([
        { isBestseller: 'desc' },
        { isNew: 'desc' },
        { createdAt: 'desc' },
      ]);
    });

    it('excludes the product itself via the NOT clause', async () => {
      prisma.product.findFirst.mockResolvedValue(
        makeProduct({ id: 'self-id', categoryId: 'cat-1' }),
      );
      prisma.product.findMany.mockResolvedValue([]);

      await service.findRelated('atta');

      expect(prisma.product.findMany.mock.calls[0][0].where.NOT).toEqual({
        id: 'self-id',
      });
    });

    it('returns [] when the product has no categoryId', async () => {
      prisma.product.findFirst.mockResolvedValue(
        makeProduct({ id: 'p1', categoryId: null }),
      );

      const result = await service.findRelated('no-category');

      expect(result).toEqual([]);
      expect(prisma.product.findMany).not.toHaveBeenCalled();
    });

    it('returns [] when the product itself is not found', async () => {
      prisma.product.findFirst.mockResolvedValue(null);

      const result = await service.findRelated('missing');

      expect(result).toEqual([]);
      expect(prisma.product.findMany).not.toHaveBeenCalled();
    });

    it('filters out-of-stock and inactive products via the query (isActive/stock built into where)', async () => {
      prisma.product.findFirst.mockResolvedValue(
        makeProduct({ id: 'p1', categoryId: 'cat-1' }),
      );
      prisma.product.findMany.mockResolvedValue([]);

      await service.findRelated('atta');

      const where = prisma.product.findMany.mock.calls[0][0].where;
      expect(where.isActive).toBe(true);
      expect(where.stock).toEqual({ gt: 0 });
    });
  });

  describe('create', () => {
    it('rejects a duplicate SKU (409)', async () => {
      prisma.product.findFirst.mockResolvedValueOnce(makeProduct()); // sku clash
      await expect(
        service.create({
          name: 'Atta',
          priceMinor: 34900,
          mrpMinor: 42000,
          sku: 'SKU1',
        }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('creates with a generated unique slug', async () => {
      prisma.product.findFirst.mockResolvedValue(null); // sku free + slug free
      prisma.product.create.mockImplementation(
        ({ data }: { data: Partial<Product> }) => makeProduct(data),
      );
      const created = await service.create({
        name: 'Cold Pressed Oil',
        priceMinor: 39900,
        mrpMinor: 48000,
      });
      expect(created.slug).toBe('cold-pressed-oil');
    });
  });

  describe('remove', () => {
    it('soft-deletes and deactivates', async () => {
      prisma.product.findFirst.mockResolvedValue(makeProduct());
      prisma.product.update.mockResolvedValue(makeProduct());
      await service.remove('p1');
      const arg = prisma.product.update.mock.calls[0][0];
      expect(arg.data.deletedAt).toBeInstanceOf(Date);
      expect(arg.data.isActive).toBe(false);
    });
  });
});
