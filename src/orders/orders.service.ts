import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateOrderDto } from './dto/order.dto';

// Simple, predictable shipping policy (server-authoritative). Real Shiprocket
// rating is a later FEAT (ADR-0010). Money is integer paise.
const FREE_SHIPPING_THRESHOLD_MINOR = 49900; // ₹499
const FLAT_SHIPPING_MINOR = 4900; // ₹49

const ORDER_INCLUDE = {
  items: true,
  payments: { orderBy: { createdAt: 'desc' } },
} satisfies Prisma.OrderInclude;

@Injectable()
export class OrdersService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Place an order from the user's cart. Runs in a transaction with atomic
   * conditional stock decrements (prevents overselling), a sequence-backed order
   * number, a full address snapshot, and cart clearing. COD → PLACED with a
   * COD_PENDING payment; online (mock, no live gateway yet) → PLACED + SUCCESS.
   */
  async checkout(userId: string, email: string | null, dto: CreateOrderDto) {
    const cart = await this.prisma.cartItem.findMany({
      where: { userId },
      include: { product: true },
      orderBy: { productId: 'asc' }, // stable order → deadlock avoidance
    });
    if (cart.length === 0) throw new BadRequestException('Your cart is empty');

    const address = await this.prisma.address.findFirst({
      where: { id: dto.addressId, userId, deletedAt: null },
    });
    if (!address) throw new NotFoundException('Address not found');

    return this.prisma.$transaction(async (tx) => {
      let subtotalMinor = 0;
      const itemsData: Prisma.OrderItemCreateManyOrderInput[] = [];

      for (const line of cart) {
        const p = line.product;
        // Atomic conditional decrement: only succeeds if enough active stock.
        const dec = await tx.product.updateMany({
          where: {
            id: p.id,
            isActive: true,
            deletedAt: null,
            stock: { gte: line.quantity },
          },
          data: { stock: { decrement: line.quantity } },
        });
        if (dec.count === 0) {
          throw new BadRequestException(
            `${p.name} is unavailable or only ${p.stock} left in stock`,
          );
        }
        const lineTotal = p.priceMinor * line.quantity;
        subtotalMinor += lineTotal;
        itemsData.push({
          productId: p.id,
          productName: p.name,
          productSlug: p.slug,
          productImage: p.images[0] ?? null,
          unitPriceMinor: p.priceMinor,
          quantity: line.quantity,
          lineTotalMinor: lineTotal,
        });
      }

      const shippingMinor =
        subtotalMinor >= FREE_SHIPPING_THRESHOLD_MINOR
          ? 0
          : FLAT_SHIPPING_MINOR;
      const totalMinor = subtotalMinor + shippingMinor;

      const orderNumber = await this.nextOrderNumber(tx);
      const isCod = dto.paymentMethod === PaymentMethod.COD;

      const order = await tx.order.create({
        data: {
          orderNumber,
          userId,
          status: OrderStatus.PLACED,
          subtotalMinor,
          shippingMinor,
          totalMinor,
          paymentMethod: dto.paymentMethod,
          addressId: address.id,
          shipName: address.fullName,
          shipPhone: address.phone,
          shipEmail: email,
          shipLine1: address.line1,
          shipLine2: address.line2,
          shipCity: address.city,
          shipState: address.state,
          shipPincode: address.pincode,
          customerNotes: dto.notes,
          placedAt: new Date(),
          items: { createMany: { data: itemsData } },
          payments: {
            create: {
              method: dto.paymentMethod,
              amountMinor: totalMinor,
              status: isCod ? PaymentStatus.COD_PENDING : PaymentStatus.SUCCESS,
            },
          },
        },
        include: ORDER_INCLUDE,
      });

      // Lock the address (snapshotted) and clear the cart.
      await tx.address.update({
        where: { id: address.id },
        data: { isLocked: true },
      });
      await tx.cartItem.deleteMany({ where: { userId } });

      return order;
    });
  }

  list(userId: string) {
    return this.prisma.order.findMany({
      where: { userId, deletedAt: null },
      orderBy: { createdAt: 'desc' },
      include: ORDER_INCLUDE,
    });
  }

  async get(userId: string, id: string) {
    const order = await this.prisma.order.findFirst({
      where: { id, userId, deletedAt: null },
      include: ORDER_INCLUDE,
    });
    if (!order) throw new NotFoundException('Order not found');
    return order;
  }

  /** Customer cancel — only while PENDING/PLACED/CONFIRMED. Restores stock. */
  async cancel(userId: string, id: string) {
    const order = await this.get(userId, id);
    const cancellable: OrderStatus[] = [
      OrderStatus.PENDING,
      OrderStatus.PLACED,
      OrderStatus.CONFIRMED,
    ];
    if (!cancellable.includes(order.status)) {
      throw new BadRequestException(
        `Order cannot be cancelled in ${order.status} state`,
      );
    }
    return this.prisma.$transaction(async (tx) => {
      for (const item of order.items) {
        if (item.productId) {
          await tx.product.updateMany({
            where: { id: item.productId },
            data: { stock: { increment: item.quantity } },
          });
        }
      }
      return tx.order.update({
        where: { id },
        data: { status: OrderStatus.CANCELLED, cancelledAt: new Date() },
        include: ORDER_INCLUDE,
      });
    });
  }

  private async nextOrderNumber(tx: Prisma.TransactionClient): Promise<string> {
    const rows = await tx.$queryRaw<
      { nextval: bigint }[]
    >`SELECT nextval('order_number_seq')`;
    const n = Number(rows[0].nextval);
    const d = new Date();
    const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    return `SB-${ymd}-${String(n).padStart(6, '0')}`;
  }
}
