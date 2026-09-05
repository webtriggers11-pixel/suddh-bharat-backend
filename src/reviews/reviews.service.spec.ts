import { ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ReviewsService } from './reviews.service';
import { PrismaService } from '../prisma/prisma.service';

describe('ReviewsService', () => {
  let prisma: {
    review: {
      findMany: jest.Mock;
      findFirst: jest.Mock;
      count: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
      aggregate: jest.Mock;
    };
    product: { findFirst: jest.Mock; update: jest.Mock };
    $transaction: jest.Mock;
  };
  let revalidate: { revalidate: jest.Mock };
  let service: ReviewsService;

  beforeEach(() => {
    prisma = {
      review: {
        findMany: jest.fn(),
        findFirst: jest.fn(),
        count: jest.fn().mockResolvedValue(0),
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
      $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
    };
    revalidate = { revalidate: jest.fn() };
    service = new ReviewsService(
      prisma as unknown as PrismaService,
      revalidate as unknown as import('../common/revalidate.service').RevalidateService,
    );
  });

  describe('create', () => {
    it('404s for a missing/inactive product', async () => {
      prisma.product.findFirst.mockResolvedValue(null);
      await expect(
        service.create('u1', { productId: 'p1', rating: 5 }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('creates an approved review with a computed userName', async () => {
      prisma.product.findFirst.mockResolvedValue({ id: 'p1' });
      prisma.review.create.mockResolvedValue({
        id: 'r1',
        userId: 'u1',
        productId: 'p1',
        rating: 5,
        title: null,
        body: null,
        isApproved: true,
        createdAt: new Date(),
        user: { name: 'Asha' },
      });
      const res = await service.create('u1', { productId: 'p1', rating: 5 });
      expect(res.userName).toBe('Asha');
      // Live on submit — there is no moderation queue to hold it back.
      expect(res.isApproved).toBe(true);
    });

    it('recomputes the product rating so a new review shows up right away', async () => {
      prisma.product.findFirst.mockResolvedValue({ id: 'p1' });
      prisma.review.create.mockResolvedValue({
        id: 'r1',
        userId: 'u1',
        productId: 'p1',
        rating: 5,
        title: null,
        body: null,
        isApproved: true,
        createdAt: new Date(),
        user: { name: 'Asha' },
      });
      await service.create('u1', { productId: 'p1', rating: 5 });
      expect(prisma.review.aggregate).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { productId: 'p1', isApproved: true, deletedAt: null },
        }),
      );
      expect(prisma.product.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'p1' } }),
      );
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
        isApproved: true,
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

  /**
   * FEAT-024 — reviews could be approved by id but never LISTED, so an admin
   * had no way to find one. Deleting someone else's review was impossible too,
   * and nothing ever refreshed the storefront's cached rating.
   */
  describe('admin moderation (FEAT-024)', () => {
    it('lists every non-deleted review, newest first, with the product', async () => {
      prisma.review.findMany.mockResolvedValue([]);
      await service.listAdmin({ page: 1, pageSize: 20 });
      const arg = prisma.review.findMany.mock.calls[0][0];
      expect(arg.where).toEqual({ deletedAt: null });
      expect(arg.orderBy).toEqual({ createdAt: 'desc' });
      expect(arg.select.product).toBeDefined();
    });

    it('filters to the pending queue when asked', async () => {
      prisma.review.findMany.mockResolvedValue([]);
      await service.listAdmin({ page: 1, pageSize: 20, status: 'pending' });
      expect(prisma.review.findMany.mock.calls[0][0].where).toEqual({
        deletedAt: null,
        isApproved: false,
      });
    });

    it('un-approves a review and recomputes the product rating', async () => {
      prisma.review.findFirst.mockResolvedValue({ id: 'r1', productId: 'p1' });
      prisma.product.findFirst.mockResolvedValue({ slug: 'atta' });
      await service.setApproved('r1', false);
      expect(prisma.review.update).toHaveBeenCalledWith({
        where: { id: 'r1' },
        data: { isApproved: false },
      });
      expect(prisma.product.update).toHaveBeenCalled();
      expect(revalidate.revalidate).toHaveBeenCalledWith([
        'products',
        'product:atta',
      ]);
    });

    it('lets an admin delete any review, not just their own', async () => {
      prisma.review.findFirst.mockResolvedValue({ id: 'r1', productId: 'p1' });
      prisma.product.findFirst.mockResolvedValue({ slug: 'atta' });
      await service.removeAsAdmin('r1');
      expect(prisma.review.update).toHaveBeenCalledWith({
        where: { id: 'r1' },
        data: { deletedAt: expect.any(Date) },
      });
      expect(revalidate.revalidate).toHaveBeenCalled();
    });

    it('busts the product cache when a review is approved', async () => {
      prisma.review.findFirst.mockResolvedValue({ id: 'r1', productId: 'p1' });
      prisma.product.findFirst.mockResolvedValue({ slug: 'atta' });
      await service.approve('r1');
      expect(revalidate.revalidate).toHaveBeenCalledWith([
        'products',
        'product:atta',
      ]);
    });
  });
});
