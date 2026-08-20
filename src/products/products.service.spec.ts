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
    service = new ProductsService(prisma as unknown as PrismaService);
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
  });

  describe('getBySlug', () => {
    it('throws NotFound for a missing product', async () => {
      prisma.product.findFirst.mockResolvedValue(null);
      await expect(service.getBySlug('nope')).rejects.toBeInstanceOf(
        NotFoundException,
      );
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
