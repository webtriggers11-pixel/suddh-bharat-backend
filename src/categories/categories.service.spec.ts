import { ConflictException, NotFoundException } from '@nestjs/common';
import { Category } from '@prisma/client';
import { CategoriesService } from './categories.service';
import { PrismaService } from '../prisma/prisma.service';

function makeCategory(over: Partial<Category> = {}): Category {
  return {
    id: 'c1',
    name: 'Food',
    slug: 'food',
    description: null,
    image: null,
    parentId: null,
    sortOrder: 0,
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    ...over,
  };
}

describe('CategoriesService', () => {
  let prisma: {
    category: {
      findMany: jest.Mock;
      findFirst: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
    };
  };
  let service: CategoriesService;

  beforeEach(() => {
    prisma = {
      category: {
        findMany: jest.fn(),
        findFirst: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
    };
    service = new CategoriesService(prisma as unknown as PrismaService);
  });

  describe('tree', () => {
    it('filters to active + non-deleted top-level categories by default', async () => {
      prisma.category.findMany.mockResolvedValue([makeCategory()]);
      await service.tree(false);
      const arg = prisma.category.findMany.mock.calls[0][0];
      expect(arg.where).toMatchObject({
        deletedAt: null,
        parentId: null,
        isActive: true,
      });
    });

    it('includes inactive when asked (admin)', async () => {
      prisma.category.findMany.mockResolvedValue([]);
      await service.tree(true);
      const arg = prisma.category.findMany.mock.calls[0][0];
      expect(arg.where.isActive).toBeUndefined();
    });
  });

  describe('create', () => {
    it('rejects a duplicate sibling name (409)', async () => {
      prisma.category.findFirst.mockResolvedValueOnce(makeCategory()); // name clash
      await expect(service.create({ name: 'Food' })).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(prisma.category.create).not.toHaveBeenCalled();
    });

    it('generates a unique slug and creates', async () => {
      prisma.category.findFirst
        .mockResolvedValueOnce(null) // name unique
        .mockResolvedValueOnce(null); // slug 'food' free
      prisma.category.create.mockImplementation(
        ({ data }: { data: Partial<Category> }) => makeCategory(data),
      );
      const created = await service.create({ name: 'Food' });
      expect(created.slug).toBe('food');
      expect(prisma.category.create).toHaveBeenCalled();
    });

    it('appends a numeric suffix when the slug is taken', async () => {
      prisma.category.findFirst
        .mockResolvedValueOnce(null) // name unique
        .mockResolvedValueOnce(makeCategory()) // 'food' taken
        .mockResolvedValueOnce(null); // 'food-1' free
      prisma.category.create.mockImplementation(
        ({ data }: { data: Partial<Category> }) => makeCategory(data),
      );
      const created = await service.create({ name: 'Food' });
      expect(created.slug).toBe('food-1');
    });
  });

  describe('getBySlug', () => {
    it('throws NotFound for an unknown slug', async () => {
      prisma.category.findFirst.mockResolvedValue(null);
      await expect(service.getBySlug('nope')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('remove', () => {
    it('soft-deletes (sets deletedAt, deactivates)', async () => {
      prisma.category.findFirst.mockResolvedValue(makeCategory());
      prisma.category.update.mockResolvedValue(makeCategory());
      await service.remove('c1');
      const arg = prisma.category.update.mock.calls[0][0];
      expect(arg.data.deletedAt).toBeInstanceOf(Date);
      expect(arg.data.isActive).toBe(false);
    });
  });
});
