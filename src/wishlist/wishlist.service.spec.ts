import { ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { WishlistService } from './wishlist.service';
import { PrismaService } from '../prisma/prisma.service';

describe('WishlistService', () => {
  let prisma: {
    wishlist: {
      findMany: jest.Mock;
      create: jest.Mock;
      deleteMany: jest.Mock;
    };
    product: { findFirst: jest.Mock };
  };
  let service: WishlistService;

  beforeEach(() => {
    prisma = {
      wishlist: {
        findMany: jest.fn(),
        create: jest.fn(),
        deleteMany: jest.fn(),
      },
      product: { findFirst: jest.fn() },
    };
    service = new WishlistService(prisma as unknown as PrismaService);
  });

  describe('add', () => {
    it('404s for a missing/inactive product', async () => {
      prisma.product.findFirst.mockResolvedValue(null);
      await expect(service.add('u1', 'p1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(prisma.wishlist.create).not.toHaveBeenCalled();
    });

    it('creates a like for an active product', async () => {
      prisma.product.findFirst.mockResolvedValue({ id: 'p1' });
      prisma.wishlist.create.mockResolvedValue({ id: 'w1', productId: 'p1' });
      const res = await service.add('u1', 'p1');
      expect(res).toEqual({ id: 'w1', productId: 'p1' });
      expect(prisma.wishlist.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: { userId: 'u1', productId: 'p1' } }),
      );
    });

    it('409s when the product is already liked (unique violation)', async () => {
      prisma.product.findFirst.mockResolvedValue({ id: 'p1' });
      prisma.wishlist.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('dup', {
          code: 'P2002',
          clientVersion: '6',
        }),
      );
      await expect(service.add('u1', 'p1')).rejects.toBeInstanceOf(
        ConflictException,
      );
    });
  });

  describe('remove', () => {
    it('hard-deletes a like', async () => {
      prisma.wishlist.deleteMany.mockResolvedValue({ count: 1 });
      await expect(service.remove('u1', 'p1')).resolves.toEqual({
        productId: 'p1',
      });
    });

    it('404s when the product was not liked', async () => {
      prisma.wishlist.deleteMany.mockResolvedValue({ count: 0 });
      await expect(service.remove('u1', 'p1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('ids', () => {
    it('returns just the liked product ids', async () => {
      prisma.wishlist.findMany.mockResolvedValue([
        { productId: 'p1' },
        { productId: 'p2' },
      ]);
      await expect(service.ids('u1')).resolves.toEqual(['p1', 'p2']);
    });
  });
});
