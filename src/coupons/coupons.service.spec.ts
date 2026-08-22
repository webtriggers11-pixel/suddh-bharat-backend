import { BadRequestException, ConflictException } from '@nestjs/common';
import { DiscountType, Prisma } from '@prisma/client';
import { CouponsService } from './coupons.service';
import { PrismaService } from '../prisma/prisma.service';

function coupon(over: Record<string, unknown> = {}) {
  return {
    id: 'c1',
    code: 'SAVE10',
    discountType: DiscountType.PERCENTAGE,
    discountValue: 10,
    minOrderMinor: 0,
    maxDiscountMinor: null,
    usageLimit: null,
    usedCount: 0,
    isActive: true,
    expiresAt: null,
    deletedAt: null,
    ...over,
  };
}

describe('CouponsService', () => {
  let prisma: {
    coupon: { findFirst: jest.Mock; create: jest.Mock };
  };
  let service: CouponsService;

  beforeEach(() => {
    prisma = { coupon: { findFirst: jest.fn(), create: jest.fn() } };
    service = new CouponsService(prisma as unknown as PrismaService);
  });

  describe('validate', () => {
    it('400s for an unknown/inactive code', async () => {
      prisma.coupon.findFirst.mockResolvedValue(null);
      await expect(service.validate('nope', 10000)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('computes a percentage discount and caps at maxDiscount', async () => {
      prisma.coupon.findFirst.mockResolvedValue(
        coupon({ discountValue: 20, maxDiscountMinor: 3000 }),
      );
      const q = await service.validate('SAVE10', 50000); // 20% = 10000, capped 3000
      expect(q.discountAmountMinor).toBe(3000);
      expect(q.finalTotalMinor).toBe(47000);
    });

    it('computes a fixed discount, never exceeding the cart', async () => {
      prisma.coupon.findFirst.mockResolvedValue(
        coupon({ discountType: DiscountType.FIXED, discountValue: 9000 }),
      );
      const q = await service.validate('X', 5000); // fixed 9000 > cart → clamp 5000
      expect(q.discountAmountMinor).toBe(5000);
      expect(q.finalTotalMinor).toBe(0);
    });

    it('enforces the minimum order value', async () => {
      prisma.coupon.findFirst.mockResolvedValue(
        coupon({ minOrderMinor: 50000 }),
      );
      await expect(service.validate('X', 10000)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('rejects an expired coupon', async () => {
      prisma.coupon.findFirst.mockResolvedValue(
        coupon({ expiresAt: new Date(Date.now() - 1000) }),
      );
      await expect(service.validate('X', 10000)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('rejects a coupon at its usage limit', async () => {
      prisma.coupon.findFirst.mockResolvedValue(
        coupon({ usageLimit: 5, usedCount: 5 }),
      );
      await expect(service.validate('X', 10000)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });

  describe('create', () => {
    it('uppercases the code and 409s on a duplicate', async () => {
      prisma.coupon.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('dup', {
          code: 'P2002',
          clientVersion: '6',
        }),
      );
      await expect(
        service.create({
          code: 'save10',
          discountType: DiscountType.PERCENTAGE,
          discountValue: 10,
        }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.coupon.create.mock.calls[0][0].data.code).toBe('SAVE10');
    });
  });
});
