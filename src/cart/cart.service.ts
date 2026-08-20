import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface CartLine {
  id: string;
  productId: string;
  name: string;
  slug: string;
  image: string | null;
  priceMinor: number;
  quantity: number;
  lineTotalMinor: number;
  stock: number;
  isActive: boolean;
}

export interface CartSummary {
  items: CartLine[];
  itemCount: number;
  totalMinor: number;
}

/**
 * DB-backed per-user cart (ADR-0010). Totals are recomputed server-side from
 * live product prices (never trusts a client). Stock is checked on add/update.
 */
@Injectable()
export class CartService {
  constructor(private readonly prisma: PrismaService) {}

  async summary(userId: string): Promise<CartSummary> {
    const rows = await this.prisma.cartItem.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' },
      include: { product: true },
    });

    const items: CartLine[] = rows.map((row) => {
      const active = row.product.isActive && row.product.deletedAt === null;
      return {
        id: row.id,
        productId: row.productId,
        name: row.product.name,
        slug: row.product.slug,
        image: row.product.images[0] ?? null,
        priceMinor: row.product.priceMinor,
        quantity: row.quantity,
        lineTotalMinor: row.product.priceMinor * row.quantity,
        stock: row.product.stock,
        isActive: active,
      };
    });

    const totalMinor = items
      .filter((i) => i.isActive)
      .reduce((sum, i) => sum + i.lineTotalMinor, 0);

    return { items, itemCount: items.length, totalMinor };
  }

  async add(
    userId: string,
    productId: string,
    quantity: number,
  ): Promise<CartSummary> {
    if (quantity < 1) throw new BadRequestException('Quantity must be ≥ 1');
    const product = await this.requireActiveProduct(productId);

    const existing = await this.prisma.cartItem.findUnique({
      where: { userId_productId: { userId, productId } },
    });
    const newQty = (existing?.quantity ?? 0) + quantity;
    this.assertStock(product.stock, newQty);

    await this.prisma.cartItem.upsert({
      where: { userId_productId: { userId, productId } },
      create: { userId, productId, quantity },
      update: { quantity: newQty },
    });
    return this.summary(userId);
  }

  async setQuantity(
    userId: string,
    productId: string,
    quantity: number,
  ): Promise<CartSummary> {
    if (quantity < 1) throw new BadRequestException('Quantity must be ≥ 1');
    const existing = await this.prisma.cartItem.findUnique({
      where: { userId_productId: { userId, productId } },
    });
    if (!existing) throw new NotFoundException('Item not in cart');
    const product = await this.requireActiveProduct(productId);
    this.assertStock(product.stock, quantity);

    await this.prisma.cartItem.update({
      where: { userId_productId: { userId, productId } },
      data: { quantity },
    });
    return this.summary(userId);
  }

  async remove(userId: string, productId: string): Promise<CartSummary> {
    const existing = await this.prisma.cartItem.findUnique({
      where: { userId_productId: { userId, productId } },
    });
    if (!existing) throw new NotFoundException('Item not in cart');
    await this.prisma.cartItem.delete({
      where: { userId_productId: { userId, productId } },
    });
    return this.summary(userId);
  }

  async clear(userId: string): Promise<CartSummary> {
    await this.prisma.cartItem.deleteMany({ where: { userId } });
    return this.summary(userId);
  }

  private async requireActiveProduct(productId: string) {
    const product = await this.prisma.product.findFirst({
      where: { id: productId, deletedAt: null, isActive: true },
    });
    if (!product) throw new NotFoundException('Product not found');
    return product;
  }

  private assertStock(stock: number, wanted: number): void {
    if (stock < wanted) {
      throw new BadRequestException(`Only ${stock} units available`);
    }
  }
}
