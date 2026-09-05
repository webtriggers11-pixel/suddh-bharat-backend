import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RevalidateService } from '../common/revalidate.service';
import { CreateReviewDto } from './dto/review.dto';
import { AdminReviewQueryDto } from './dto/admin-review.dto';
import type { Paginated } from '../products/products.service';

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

/** One row of the moderation queue. */
export interface AdminReviewRow {
  id: string;
  rating: number;
  title: string | null;
  body: string | null;
  isApproved: boolean;
  createdAt: Date;
  updatedAt: Date;
  userName: string;
  userEmail: string | null;
  product: { id: string; name: string; slug: string } | null;
}

/** Moderation-queue row: the public shape plus who wrote it and what it's on. */
const ADMIN_REVIEW_SELECT = {
  ...REVIEW_SELECT,
  updatedAt: true,
  user: { select: { name: true, email: true } },
  product: { select: { id: true, name: true, slug: true } },
} satisfies Prisma.ReviewSelect;

@Injectable()
export class ReviewsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly revalidate: RevalidateService,
  ) {}

  /**
   * Moderation queue (FEAT-024). Reviews could be approved by id but never
   * listed, so an admin had no way to find one in the first place.
   */
  async listAdmin(
    query: AdminReviewQueryDto,
  ): Promise<Paginated<AdminReviewRow>> {
    const page = query.page ?? 1;
    const pageSize = Math.min(query.pageSize ?? 20, 100);
    const where: Prisma.ReviewWhereInput = { deletedAt: null };
    if (query.status === 'pending') where.isApproved = false;
    else if (query.status === 'approved') where.isApproved = true;
    if (query.productId) where.productId = query.productId;

    const [total, rows] = await this.prisma.$transaction([
      this.prisma.review.count({ where }),
      this.prisma.review.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: ADMIN_REVIEW_SELECT,
      }),
    ]);

    return {
      items: rows.map((r) => ({
        id: r.id,
        rating: r.rating,
        title: r.title,
        body: r.body,
        isApproved: r.isApproved,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        userName: r.user?.name?.trim() || 'Anonymous',
        userEmail: r.user?.email ?? null,
        product: r.product,
      })),
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize) || 0,
    };
  }

  /**
   * Approve or hide a review (FEAT-024). `approve` alone could only ever let
   * content through — moderation also has to take it back down.
   */
  async setApproved(id: string, isApproved: boolean) {
    const review = await this.requireById(id);
    await this.prisma.review.update({
      where: { id },
      data: { isApproved },
    });
    await this.recompute(review.productId);
    return { id, isApproved };
  }

  /** Admin soft delete — any review, not just the caller's own (FEAT-024). */
  async removeAsAdmin(id: string) {
    const review = await this.requireById(id);
    await this.prisma.review.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
    await this.recompute(review.productId);
    return { id };
  }

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
  approve(id: string) {
    return this.setApproved(id, true);
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

    // The storefront caches the rating and count on the product card/page —
    // without this a moderation decision stayed invisible for the full TTL.
    const product = await this.prisma.product.findFirst({
      where: { id: productId },
      select: { slug: true },
    });
    this.revalidate.revalidate(
      product ? ['products', `product:${product.slug}`] : ['products'],
    );
  }

  private async requireById(id: string) {
    const review = await this.prisma.review.findFirst({
      where: { id, deletedAt: null },
    });
    if (!review) throw new NotFoundException('Review not found');
    return review;
  }
}
