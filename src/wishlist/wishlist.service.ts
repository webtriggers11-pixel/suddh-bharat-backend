import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/** A wishlist row with the denormalized product snapshot for storefront display. */
const WISHLIST_SELECT = {
  id: true,
  productId: true,
  createdAt: true,
  product: {
    select: {
      id: true,
      name: true,
      slug: true,
      priceMinor: true,
      mrpMinor: true,
      images: true,
      stock: true,
      isActive: true,
      isNew: true,
      isBestseller: true,
      material: true,
      avgRating: true,
      reviewCount: true,
    },
  },
} satisfies Prisma.WishlistSelect;

@Injectable()
export class WishlistService {
  constructor(private readonly prisma: PrismaService) {}

  /** Liked products, newest first. Skips products that were hard-removed. */
  list(userId: string) {
    return this.prisma.wishlist.findMany({
      where: { userId, product: { deletedAt: null } },
      orderBy: { createdAt: 'desc' },
      take: 200, // bound the response
      select: WISHLIST_SELECT,
    });
  }

  /** Just the liked product ids — cheap payload the UI uses to mark hearts. */
  async ids(userId: string): Promise<string[]> {
    const rows = await this.prisma.wishlist.findMany({
      where: { userId, product: { deletedAt: null } },
      select: { productId: true },
    });
    return rows.map((r) => r.productId);
  }

  /** Like a product. 404 if it is missing/inactive; 409 if already liked. */
  async add(userId: string, productId: string) {
    const product = await this.prisma.product.findFirst({
      where: { id: productId, isActive: true, deletedAt: null },
      select: { id: true },
    });
    if (!product) throw new NotFoundException('Product not found');

    try {
      return await this.prisma.wishlist.create({
        data: { userId, productId },
        select: WISHLIST_SELECT,
      });
    } catch (e) {
      // Unique (userId, productId) violation → already liked.
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        throw new ConflictException('Already in your wishlist');
      }
      throw e;
    }
  }

  /** Unlike a product (hard delete). 404 if it was not liked. */
  async remove(userId: string, productId: string) {
    const res = await this.prisma.wishlist.deleteMany({
      where: { userId, productId },
    });
    if (res.count === 0) {
      throw new NotFoundException('Not in your wishlist');
    }
    return { productId };
  }
}
