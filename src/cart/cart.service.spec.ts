import { BadRequestException, NotFoundException } from '@nestjs/common';
import { CartService } from './cart.service';
import { PrismaService } from '../prisma/prisma.service';

function makeProduct(over: Record<string, unknown> = {}) {
  return {
    id: 'p1',
    name: 'Atta',
    slug: 'atta',
    priceMinor: 34900,
    stock: 10,
    images: ['img1'],
    isActive: true,
    deletedAt: null,
    ...over,
  };
}

describe('CartService', () => {
  let prisma: {
    cartItem: {
      findMany: jest.Mock;
      findUnique: jest.Mock;
      upsert: jest.Mock;
      update: jest.Mock;
      delete: jest.Mock;
      deleteMany: jest.Mock;
    };
    product: { findFirst: jest.Mock };
  };
  let service: CartService;

  beforeEach(() => {
    prisma = {
      cartItem: {
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn(),
        upsert: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
        deleteMany: jest.fn(),
      },
      product: { findFirst: jest.fn() },
    };
    service = new CartService(prisma as unknown as PrismaService);
  });

  describe('summary', () => {
    it('computes totals over active products from live prices', async () => {
      prisma.cartItem.findMany.mockResolvedValue([
        { id: 'c1', productId: 'p1', quantity: 2, product: makeProduct() },
        {
          id: 'c2',
          productId: 'p2',
          quantity: 1,
          product: makeProduct({ id: 'p2', priceMinor: 19900 }),
        },
      ]);
      const summary = await service.summary('u1');
      expect(summary.itemCount).toBe(2);
      expect(summary.totalMinor).toBe(34900 * 2 + 19900);
    });

    it('excludes inactive products from the total', async () => {
      prisma.cartItem.findMany.mockResolvedValue([
        {
          id: 'c1',
          productId: 'p1',
          quantity: 1,
          product: makeProduct({ isActive: false }),
        },
      ]);
      const summary = await service.summary('u1');
      expect(summary.totalMinor).toBe(0);
      expect(summary.items[0].isActive).toBe(false);
    });
  });

  describe('add', () => {
    it('404s for a missing/inactive product', async () => {
      prisma.product.findFirst.mockResolvedValue(null);
      await expect(service.add('u1', 'p1', 1)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('rejects (and clamps) when the resulting qty exceeds stock', async () => {
      prisma.product.findFirst.mockResolvedValue(makeProduct({ stock: 3 }));
      // Atomic upsert lands qty=5, service clamps to 3 and throws.
      prisma.cartItem.upsert.mockResolvedValue({ quantity: 5 });
      await expect(service.add('u1', 'p1', 5)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(prisma.cartItem.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { quantity: 3 } }),
      );
    });

    it('increments atomically (no read-then-set) and accepts within stock', async () => {
      prisma.product.findFirst.mockResolvedValue(makeProduct({ stock: 10 }));
      prisma.cartItem.upsert.mockResolvedValue({ quantity: 5 });
      await service.add('u1', 'p1', 3);
      const arg = prisma.cartItem.upsert.mock.calls[0][0];
      expect(arg.update.quantity).toEqual({ increment: 3 });
      expect(arg.create.quantity).toBe(3);
    });
  });

  describe('setQuantity', () => {
    it('404s when the item is not in the cart', async () => {
      prisma.cartItem.findUnique.mockResolvedValue(null);
      await expect(service.setQuantity('u1', 'p1', 2)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('remove', () => {
    it('404s when removing an absent line', async () => {
      prisma.cartItem.findUnique.mockResolvedValue(null);
      await expect(service.remove('u1', 'p1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });
});
