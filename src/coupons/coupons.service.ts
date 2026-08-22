import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Coupon, DiscountType, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateCouponDto, UpdateCouponDto } from './dto/coupon.dto';

export interface CouponQuote {
  couponId: string;
  code: string;
  discountType: DiscountType;
  discountValue: number;
  discountAmountMinor: number;
  finalTotalMinor: number;
}

const rupees = (minor: number) => Math.round(minor / 100);

@Injectable()
export class CouponsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Compute the discount a coupon yields on a cart total (no side effects). */
  private computeDiscount(coupon: Coupon, cartTotalMinor: number): number {
    let discount =
      coupon.discountType === DiscountType.PERCENTAGE
        ? Math.round((cartTotalMinor * coupon.discountValue) / 100)
        : coupon.discountValue;
    if (
      coupon.discountType === DiscountType.PERCENTAGE &&
      coupon.maxDiscountMinor != null
    ) {
      discount = Math.min(discount, coupon.maxDiscountMinor);
    }
    // Never discount more than the cart, never negative.
    return Math.max(0, Math.min(discount, cartTotalMinor));
  }

  /**
   * Validate a code against a cart total and return the quote, or throw a 400
   * with a shopper-friendly reason. Does NOT consume usage (that happens
   * atomically at order placement).
   */
  async validate(code: string, cartTotalMinor: number): Promise<CouponQuote> {
    const coupon = await this.prisma.coupon.findFirst({
      where: {
        code: code.trim().toUpperCase(),
        isActive: true,
        deletedAt: null,
      },
    });
    if (!coupon) {
      throw new BadRequestException('Invalid or inactive coupon');
    }
    if (coupon.expiresAt && coupon.expiresAt.getTime() < Date.now()) {
      throw new BadRequestException('This coupon has expired');
    }
    if (coupon.usageLimit != null && coupon.usedCount >= coupon.usageLimit) {
      throw new BadRequestException('This coupon has reached its usage limit');
    }
    if (cartTotalMinor < coupon.minOrderMinor) {
      throw new BadRequestException(
        `Add ₹${rupees(coupon.minOrderMinor)} of items to use this coupon`,
      );
    }
    const discountAmountMinor = this.computeDiscount(coupon, cartTotalMinor);
    return {
      couponId: coupon.id,
      code: coupon.code,
      discountType: coupon.discountType,
      discountValue: coupon.discountValue,
      discountAmountMinor,
      finalTotalMinor: cartTotalMinor - discountAmountMinor,
    };
  }

  /**
   * Atomically consume one use of a coupon inside a checkout transaction. The
   * `usedCount < usageLimit` guard (raw SQL, since Prisma can't compare two
   * columns in a where) makes the limit concurrency-safe — returns false if the
   * coupon just hit its cap (caller rejects the coupon, not the order).
   */
  async consume(
    tx: Prisma.TransactionClient,
    couponId: string,
  ): Promise<boolean> {
    const affected = await tx.$executeRaw`
      UPDATE "Coupon"
         SET "usedCount" = "usedCount" + 1, "updatedAt" = now()
       WHERE "id" = ${couponId}
         AND "isActive" = true
         AND "deletedAt" IS NULL
         AND ("usageLimit" IS NULL OR "usedCount" < "usageLimit")`;
    return affected === 1;
  }

  /**
   * Release one previously-consumed use of a coupon (floored at 0), inside a
   * transaction. Called when an order that consumed a coupon is cancelled or
   * refunded, so the usage returns to the pool. Idempotency is the caller's
   * responsibility (release exactly once per consume).
   */
  async release(tx: Prisma.TransactionClient, couponId: string): Promise<void> {
    await tx.$executeRaw`
      UPDATE "Coupon"
         SET "usedCount" = GREATEST("usedCount" - 1, 0), "updatedAt" = now()
       WHERE "id" = ${couponId}`;
  }

  // ---- Admin CRUD -----------------------------------------------------------

  list() {
    return this.prisma.coupon.findMany({
      where: { deletedAt: null },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });
  }

  async create(dto: CreateCouponDto): Promise<Coupon> {
    try {
      return await this.prisma.coupon.create({
        data: {
          code: dto.code.trim().toUpperCase(),
          discountType: dto.discountType,
          discountValue: dto.discountValue,
          minOrderMinor: dto.minOrderMinor ?? 0,
          maxDiscountMinor: dto.maxDiscountMinor,
          usageLimit: dto.usageLimit,
          isActive: dto.isActive ?? true,
          expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null,
        },
      });
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        throw new ConflictException('A coupon with that code already exists');
      }
      throw e;
    }
  }

  async update(id: string, dto: UpdateCouponDto): Promise<Coupon> {
    await this.requireById(id);
    return this.prisma.coupon.update({
      where: { id },
      data: {
        discountType: dto.discountType,
        discountValue: dto.discountValue,
        minOrderMinor: dto.minOrderMinor,
        maxDiscountMinor: dto.maxDiscountMinor,
        usageLimit: dto.usageLimit,
        isActive: dto.isActive,
        ...(dto.expiresAt !== undefined
          ? { expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null }
          : {}),
      },
    });
  }

  async remove(id: string): Promise<{ id: string }> {
    await this.requireById(id);
    await this.prisma.coupon.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
    return { id };
  }

  private async requireById(id: string): Promise<Coupon> {
    const coupon = await this.prisma.coupon.findFirst({
      where: { id, deletedAt: null },
    });
    if (!coupon) throw new NotFoundException('Coupon not found');
    return coupon;
  }
}
