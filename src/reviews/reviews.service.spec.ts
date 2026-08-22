import { ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ReviewsService } from './reviews.service';
import { PrismaService } from '../prisma/prisma.service';

describe('ReviewsService', () => {
  let prisma: {
    review: {
      findMany: jest.Mock;
      findFirst: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
      aggregate: jest.Mock;
    };
    product: { findFirst: jest.Mock; update: jest.Mock };
  };
  let service: ReviewsService;

  beforeEach(() => {
    prisma = {
      review: {
        findMany: jest.fn(),
        findFirst: jest.fn(),
        create: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
        aggregate: jest
          .fn()
          .mockResolvedValue({ _avg: { rating: 4.5 }, _count: 2 }),
      },
      product: {
        findFirst: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    service = new ReviewsService(prisma as unknown as PrismaService);
  });

  describe('create', () => {
    it('404s for a missing/inactive product', async () => {
      prisma.product.findFirst.mockResolvedValue(null);
      await expect(
        service.create('u1', { productId: 'p1', rating: 5 }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('creates an unapproved review with a computed userName', async () => {
      prisma.product.findFirst.mockResolvedValue({ id: 'p1' });
      prisma.review.create.mockResolvedValue({
        id: 'r1',
        userId: 'u1',
        productId: 'p1',
        rating: 5,
        title: null,
        body: null,
        isApproved: false,
        createdAt: new Date(),
        user: { name: 'Asha' },
      });
      const res = await service.create('u1', { productId: 'p1', rating: 5 });
      expect(res.userName).toBe('Asha');
      expect(res.isApproved).toBe(false);
    });

    it('409s on a duplicate (user already reviewed)', async () => {
      prisma.product.findFirst.mockResolvedValue({ id: 'p1' });
      prisma.review.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('dup', {
          code: 'P2002',
          clientVersion: '6',
        }),
      );
      await expect(
        service.create('u1', { productId: 'p1', rating: 4 }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('falls back to "Anonymous" when the user has no name', async () => {
      prisma.product.findFirst.mockResolvedValue({ id: 'p1' });
      prisma.review.create.mockResolvedValue({
        id: 'r1',
        userId: 'u1',
        productId: 'p1',
        rating: 3,
        title: null,
        body: null,
        isApproved: false,
        createdAt: new Date(),
        user: { name: null },
      });
      const res = await service.create('u1', { productId: 'p1', rating: 3 });
      expect(res.userName).toBe('Anonymous');
    });
  });

  describe('approve', () => {
    it('approves and recomputes the product rating (2dp)', async () => {
      prisma.review.findFirst.mockResolvedValue({ id: 'r1', productId: 'p1' });
      await service.approve('r1');
      expect(prisma.review.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { isApproved: true } }),
      );
      expect(prisma.product.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'p1' },
          data: { avgRating: 4.5, reviewCount: 2 },
        }),
      );
    });
  });

  describe('remove', () => {
    it('owner-only soft delete + recompute', async () => {
      prisma.review.findFirst.mockResolvedValue({ id: 'r1', productId: 'p1' });
      await service.remove('u1', 'r1');
      expect(prisma.review.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ deletedAt: expect.any(Date) }),
        }),
      );
      expect(prisma.product.update).toHaveBeenCalled(); // recompute
    });

    it('404s when the review is not the caller’s', async () => {
      prisma.review.findFirst.mockResolvedValue(null);
      await expect(service.remove('u1', 'r1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('resets rating to 0 when no approved reviews remain', async () => {
      prisma.review.findFirst.mockResolvedValue({ id: 'r1', productId: 'p1' });
      prisma.review.aggregate.mockResolvedValue({
        _avg: { rating: null },
        _count: 0,
      });
      await service.remove('u1', 'r1');
      expect(prisma.product.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { avgRating: 0, reviewCount: 0 } }),
      );
    });
  });
});
