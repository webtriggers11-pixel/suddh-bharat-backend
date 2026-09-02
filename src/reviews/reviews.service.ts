import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateReviewDto } from './dto/review.dto';

const REVIEW_SELECT = {
  id: true,
  userId: true,
  productId: true,
  rating: true,
  title: true,
  body: true,
  isApproved: true,
  createdAt: true,
  user: { select: { name: true } },
} satisfies Prisma.ReviewSelect;

type RawReview = Prisma.ReviewGetPayload<{ select: typeof REVIEW_SELECT }>;

/** Public shape — `userName` computed, staff/user ids kept minimal. */
function toResponse(r: RawReview) {
  return {
    id: r.id,
    productId: r.productId,
    rating: r.rating,
    title: r.title,
    body: r.body,
    isApproved: r.isApproved,
    createdAt: r.createdAt,
    userName: r.user?.name?.trim() || 'Anonymous',
  };
}

@Injectable()
export class ReviewsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Approved reviews for a product, newest first (public). */
  async listForProduct(productId: string) {
    const rows = await this.prisma.review.findMany({
      where: { productId, isApproved: true, deletedAt: null },
      orderBy: { createdAt: 'desc' },
      take: 200,
      select: REVIEW_SELECT,
    });
    return rows.map(toResponse);
  }

  /** The current user's own reviews (approved or not). */
  async listMine(userId: string) {
    const rows = await this.prisma.review.findMany({
      where: { userId, deletedAt: null },
      orderBy: { createdAt: 'desc' },
      take: 200,
      select: REVIEW_SELECT,
    });
    return rows.map(toResponse);
  }

  /** Create a review — one per (user, product). Live immediately (the schema
   * defaults isApproved to true): there is no moderation queue, so a review
   * held back for approval would never be seen by anyone. Moderation is
   * reactive — an unwanted review is removed, not withheld. */
  async create(userId: string, dto: CreateReviewDto) {
    const product = await this.prisma.product.findFirst({
      where: { id: dto.productId, isActive: true, deletedAt: null },
      select: { id: true },
    });
    if (!product) throw new NotFoundException('Product not found');

    try {
      const created = await this.prisma.review.create({
        data: {
          userId,
          productId: dto.productId,
          rating: dto.rating,
          title: dto.title,
          body: dto.body,
        },
        select: REVIEW_SELECT,
      });
      // Counts toward the product's rating the moment it lands, so
      // avgRating/reviewCount never drift behind the reviews on show.
      await this.recompute(dto.productId);
      return toResponse(created);
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        throw new ConflictException('You have already reviewed this product');
      }
      throw e;
    }
  }

  /** Approve a review (admin) → recompute the product's rating aggregates. */
  async approve(id: string) {
    const review = await this.requireById(id);
    await this.prisma.review.update({
      where: { id },
      data: { isApproved: true },
    });
    await this.recompute(review.productId);
    return { id, isApproved: true };
  }

  /** Owner-only soft delete → also recompute (fixes the spec's stale-aggregate bug). */
  async remove(userId: string, id: string) {
    const review = await this.prisma.review.findFirst({
      where: { id, userId, deletedAt: null },
    });
    if (!review) throw new NotFoundException('Review not found');
    await this.prisma.review.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
    await this.recompute(review.productId);
    return { id };
  }

  /** Recompute avgRating (2dp) + reviewCount over approved, non-deleted reviews. */
  private async recompute(productId: string) {
    const agg = await this.prisma.review.aggregate({
      where: { productId, isApproved: true, deletedAt: null },
      _avg: { rating: true },
      _count: true,
    });
    await this.prisma.product.update({
      where: { id: productId },
      data: {
        avgRating: agg._avg.rating
          ? Math.round(agg._avg.rating * 100) / 100
          : 0,
        reviewCount: agg._count,
      },
    });
  }

  private async requireById(id: string) {
    const review = await this.prisma.review.findFirst({
      where: { id, deletedAt: null },
    });
    if (!review) throw new NotFoundException('Review not found');
    return review;
  }
}
