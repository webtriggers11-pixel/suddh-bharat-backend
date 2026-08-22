import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ShippingService } from '../shipping/shipping.service';
import { StoreConfigService } from '../store-config/store-config.service';
import { CouponsService } from '../coupons/coupons.service';
import { reserveStock, releaseStock } from '../common/stock';
import {
  CreateOrderDto,
  OrderListQueryDto,
  UpdateStatusDto,
} from './dto/order.dto';

const ORDER_INCLUDE = {
  items: true,
  payments: { orderBy: { createdAt: 'desc' } },
  shipment: true,
} satisfies Prisma.OrderInclude;

/** Admin state machine — the only allowed forward/side transitions. */
const ALLOWED_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  [OrderStatus.PENDING]: [OrderStatus.CANCELLED],
  [OrderStatus.PLACED]: [OrderStatus.CANCELLED],
  [OrderStatus.CONFIRMED]: [OrderStatus.PROCESSING, OrderStatus.CANCELLED],
  [OrderStatus.PROCESSING]: [OrderStatus.SHIPPED, OrderStatus.CANCELLED],
  [OrderStatus.SHIPPED]: [OrderStatus.OUT_FOR_DELIVERY],
  [OrderStatus.OUT_FOR_DELIVERY]: [OrderStatus.DELIVERED],
  [OrderStatus.DELIVERED]: [OrderStatus.REFUND_INITIATED],
  [OrderStatus.CANCELLED]: [OrderStatus.REFUND_INITIATED],
  [OrderStatus.REFUND_INITIATED]: [OrderStatus.REFUNDED],
  [OrderStatus.REFUNDED]: [],
};

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly shipping: ShippingService,
    private readonly store: StoreConfigService,
    private readonly coupons: CouponsService,
  ) {}

  /**
   * Place an order from the user's cart. Server-authoritative throughout:
   *  - stock is decremented atomically & conditionally (no overselling),
   *  - shipping is priced from Shiprocket live rates (flat fallback on failure),
   *  - COD availability/charge and free-shipping threshold come from store policy,
   *  - COD → PLACED + COD_PENDING; online → PENDING + INITIATED (paid via /payment).
   * The order number is drawn from an atomic Postgres sequence.
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

    const isCod = dto.paymentMethod === PaymentMethod.COD;
    const policy = this.store.shippingPolicy();
    if (isCod && !policy.codEnabled) {
      throw new BadRequestException('Cash on delivery is not available');
    }

    // Pre-compute subtotal + line snapshots from the loaded cart (same product
    // objects used for the in-transaction conditional decrement).
    let subtotalMinor = 0;
    const itemsData: Prisma.OrderItemCreateManyOrderInput[] = [];
    for (const line of cart) {
      const p = line.product;
      if (line.quantity < 1) {
        throw new BadRequestException('Invalid quantity in cart');
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

    if (policy.minOrderMinor > 0 && subtotalMinor < policy.minOrderMinor) {
      throw new BadRequestException(
        `Minimum order value is ₹${(policy.minOrderMinor / 100).toFixed(0)}`,
      );
    }

    // ---- Shipping (server-authoritative) -------------------------------------
    const free =
      policy.freeShippingThresholdMinor !== null &&
      subtotalMinor >= policy.freeShippingThresholdMinor;

    let shippingMinor = 0;
    let shippingActualMinor = 0;
    let shippingCourier: string | null = null;
    let shippingEtaDays: number | null = null;
    let isFreeShipping = false;

    if (free) {
      isFreeShipping = true;
    } else {
      const pkg = this.shipping.buildPackage(
        cart.map((l) => ({
          weightKg: l.product.weightKg,
          lengthCm: l.product.lengthCm,
          breadthCm: l.product.breadthCm,
          heightCm: l.product.heightCm,
          quantity: l.quantity,
        })),
      );
      try {
        const quote = await this.shipping.getLiveRate(
          address.pincode,
          pkg,
          isCod,
        );
        shippingMinor = quote.rateMinor;
        shippingActualMinor = quote.rateMinor;
        shippingCourier = quote.courierName;
        shippingEtaDays = quote.estimatedDays;
      } catch (err) {
        // Never block a sale on a courier-API hiccup — fall back to the flat fee.
        this.logger.warn(
          `Live rate failed for ${address.pincode}, using flat fee: ${String(err)}`,
        );
        shippingMinor = policy.flatShippingFeeMinor;
        shippingActualMinor = policy.flatShippingFeeMinor;
        shippingCourier = 'Standard';
        shippingEtaDays = 5;
      }
    }

    const codChargeMinor = isCod ? policy.codChargeMinor : 0;

    // ---- Coupon (server-authoritative) ---------------------------------------
    let discountMinor = 0;
    let couponCode: string | null = null;
    let couponId: string | null = null;
    if (dto.couponCode?.trim()) {
      const quote = await this.coupons.validate(dto.couponCode, subtotalMinor);
      discountMinor = quote.discountAmountMinor;
      couponCode = quote.code;
      couponId = quote.couponId;
    }

    const totalMinor =
      subtotalMinor + shippingMinor + codChargeMinor - discountMinor;

    return this.prisma.$transaction(async (tx) => {
      // Consume one coupon use atomically (guards the usage limit under load).
      // COD commits now → consume now. Online DEFERS consumption to payment
      // capture (mirrors stock), so an abandoned online payment never drains the
      // coupon's usage limit for shoppers who never pay.
      if (couponId && isCod) {
        const ok = await this.coupons.consume(tx, couponId);
        if (!ok) {
          throw new BadRequestException('This coupon is no longer available');
        }
      }

      if (isCod) {
        // COD is committed immediately → reserve all lines in ONE atomic,
        // conditional statement (no oversell; single round-trip, not N).
        const ok = await reserveStock(
          tx,
          cart.map((l) => ({ productId: l.product.id, quantity: l.quantity })),
        );
        if (!ok) {
          throw new BadRequestException(
            'One or more items just went out of stock — please review your cart',
          );
        }
      } else {
        // Online: DO NOT reserve stock, lock the address, or clear the cart yet —
        // that happens only once payment is verified (so an abandoned payment
        // never loses the cart or holds stock). Validate availability up front.
        for (const line of cart) {
          const p = line.product;
          if (!p.isActive || p.deletedAt || p.stock < line.quantity) {
            throw new BadRequestException(
              `${p.name} is unavailable or only ${p.stock} left in stock`,
            );
          }
        }
      }

      const orderNumber = await this.nextOrderNumber(tx);

      const order = await tx.order.create({
        data: {
          orderNumber,
          userId,
          status: isCod ? OrderStatus.PLACED : OrderStatus.PENDING,
          subtotalMinor,
          shippingMinor,
          shippingActualMinor,
          shippingCourier,
          shippingEtaDays,
          isFreeShipping,
          codChargeMinor,
          discountMinor,
          couponCode,
          couponId,
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
          placedAt: isCod ? new Date() : null,
          items: { createMany: { data: itemsData } },
          payments: {
            create: {
              method: dto.paymentMethod,
              amountMinor: totalMinor,
              status: isCod
                ? PaymentStatus.COD_PENDING
                : PaymentStatus.INITIATED,
            },
          },
        },
        include: ORDER_INCLUDE,
      });

      if (isCod) {
        // Commit side effects now for COD (order is PLACED). For online these run
        // in payment/verify once the payment actually succeeds.
        await tx.address.update({
          where: { id: address.id },
          data: { isLocked: true },
        });
        await tx.cartItem.deleteMany({ where: { userId } });
      }

      return order;
    });
  }

  list(userId: string) {
    return this.prisma.order.findMany({
      where: { userId, deletedAt: null },
      orderBy: { createdAt: 'desc' },
      take: 50, // bound the response — 50 most recent (older via admin/report)
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
    // Never let a customer cancel an order that already has a captured payment —
    // that path needs a refund, not a silent cancel (avoids the paid-but-cancelled
    // race). Admins handle refunds via the review flow.
    if (order.payments.some((p) => p.status === PaymentStatus.SUCCESS)) {
      throw new BadRequestException(
        'This order is already paid — contact support to request a refund',
      );
    }
    return this.restockAndCancel(order, { byAdmin: false });
  }

  // ---- Admin ----------------------------------------------------------------

  async adminList(query: OrderListQueryDto) {
    const page = Math.max(1, query.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, query.pageSize ?? 20));
    const search = query.search?.trim();

    const where: Prisma.OrderWhereInput = {
      deletedAt: null,
      ...(query.status ? { status: query.status } : {}),
      ...(search
        ? {
            OR: [
              { orderNumber: { contains: search, mode: 'insensitive' } },
              { shipName: { contains: search, mode: 'insensitive' } },
              { shipPhone: { contains: search, mode: 'insensitive' } },
              { shipEmail: { contains: search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const [total, data] = await this.prisma.$transaction([
      this.prisma.order.count({ where }),
      this.prisma.order.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: ORDER_INCLUDE,
      }),
    ]);
    return {
      data,
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    };
  }

  async adminGet(id: string) {
    const order = await this.prisma.order.findFirst({
      where: { id, deletedAt: null },
      include: {
        ...ORDER_INCLUDE,
        shipment: {
          include: { trackingEvents: { orderBy: { eventTime: 'asc' } } },
        },
      },
    });
    if (!order) throw new NotFoundException('Order not found');
    return order;
  }

  /** Admin state-machine transition with per-status side effects. */
  async updateStatus(id: string, dto: UpdateStatusDto) {
    const order = await this.adminGet(id);
    const allowed = ALLOWED_TRANSITIONS[order.status] ?? [];
    if (!allowed.includes(dto.status)) {
      throw new BadRequestException(
        `Cannot move order from ${order.status} to ${dto.status}`,
      );
    }

    if (dto.status === OrderStatus.CANCELLED) {
      return this.restockAndCancel(order, {
        byAdmin: true,
        adminNotes: dto.adminNotes,
      });
    }

    const now = new Date();
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.order.update({
        where: { id: order.id },
        data: {
          status: dto.status,
          ...(dto.adminNotes !== undefined
            ? { adminNotes: dto.adminNotes }
            : {}),
          ...(dto.status === OrderStatus.CONFIRMED ? { confirmedAt: now } : {}),
          ...(dto.status === OrderStatus.SHIPPED ? { shippedAt: now } : {}),
          ...(dto.status === OrderStatus.DELIVERED ? { deliveredAt: now } : {}),
        },
        include: ORDER_INCLUDE,
      });
      if (dto.status === OrderStatus.DELIVERED) {
        await tx.paymentTransaction.updateMany({
          where: { orderId: order.id, status: PaymentStatus.COD_PENDING },
          data: { status: PaymentStatus.COD_COLLECTED, completedAt: now },
        });
      }
      return updated;
    });
  }

  /** PLACED → CONFIRMED. Requires a payment that is paid or COD-pending. */
  async confirm(id: string) {
    const order = await this.adminGet(id);
    if (order.status !== OrderStatus.PLACED) {
      throw new BadRequestException(
        `Only a PLACED order can be confirmed (is ${order.status})`,
      );
    }
    const validPayment: PaymentStatus[] = [
      PaymentStatus.SUCCESS,
      PaymentStatus.COD_PENDING,
      PaymentStatus.COD_COLLECTED,
    ];
    const paid = order.payments.some((p) => validPayment.includes(p.status));
    if (!paid) {
      throw new BadRequestException('Order has no valid payment to confirm');
    }
    return this.prisma.order.update({
      where: { id: order.id },
      data: { status: OrderStatus.CONFIRMED, confirmedAt: new Date() },
      include: ORDER_INCLUDE,
    });
  }

  /** Admin marks a COD payment collected → order DELIVERED. */
  async confirmCod(id: string) {
    const order = await this.adminGet(id);
    const codTxn = order.payments.find(
      (p) => p.status === PaymentStatus.COD_PENDING,
    );
    if (!codTxn) {
      throw new BadRequestException('No pending COD payment on this order');
    }
    const now = new Date();
    return this.prisma.$transaction(async (tx) => {
      await tx.paymentTransaction.update({
        where: { id: codTxn.id },
        data: { status: PaymentStatus.COD_COLLECTED, completedAt: now },
      });
      return tx.order.update({
        where: { id: order.id },
        data: { status: OrderStatus.DELIVERED, deliveredAt: now },
        include: ORDER_INCLUDE,
      });
    });
  }

  async updateNotes(id: string, adminNotes: string) {
    await this.adminGet(id);
    return this.prisma.order.update({
      where: { id },
      data: { adminNotes },
      include: ORDER_INCLUDE,
    });
  }

  // ---- helpers --------------------------------------------------------------

  /**
   * Cancel an order safely under concurrency.
   *
   * The cancel transition is a COMPARE-AND-SWAP on the exact status we observed:
   * if a concurrent payment-verify (or another cancel) moved the row in the
   * meantime, our `updateMany` matches 0 rows and we abort — so a cancel can
   * never blindly overwrite a just-PLACED, just-paid order (the critical race).
   *
   * Everything else is then decided from a FRESH in-transaction read of the
   * payments (the pre-transaction snapshot may be stale):
   *  - stock is released only if it was actually reserved (COD reserves at
   *    checkout; online reserves only on capture),
   *  - a captured payment on a now-cancelled order is flagged `needsReview`
   *    (refund owed) instead of silently keeping the money.
   */
  private restockAndCancel(
    order: {
      id: string;
      orderNumber: string;
      status: OrderStatus;
      paymentMethod: PaymentMethod;
      couponId?: string | null;
      items: { productId: string | null; quantity: number }[];
    },
    opts: { byAdmin: boolean; adminNotes?: string },
  ) {
    const { byAdmin, adminNotes } = opts;
    return this.prisma.$transaction(async (tx) => {
      const now = new Date();

      // CAS: only cancel if the row is STILL in the status we saw. This takes the
      // row lock and serializes against a concurrent verify flipping it to PLACED.
      const moved = await tx.order.updateMany({
        where: { id: order.id, status: order.status, deletedAt: null },
        data: {
          status: OrderStatus.CANCELLED,
          cancelledAt: now,
          ...(adminNotes !== undefined ? { adminNotes } : {}),
        },
      });
      if (moved.count !== 1) {
        // Someone moved it first (paid/placed/already-cancelled) — don't touch
        // stock or payments. The caller should re-fetch and reassess.
        throw new ConflictException(
          'This order was just updated — refresh and try again',
        );
      }

      // Fresh payment state (a verify may have captured since the pre-tx read).
      const payments = await tx.paymentTransaction.findMany({
        where: { orderId: order.id },
        select: { status: true },
      });
      const captured = payments.some((p) => p.status === PaymentStatus.SUCCESS);
      // Online holds stock only once captured; COD holds it from checkout.
      const stockReserved =
        order.paymentMethod === PaymentMethod.COD || captured;

      if (stockReserved) {
        await releaseStock(
          tx,
          order.items
            .filter((i): i is { productId: string; quantity: number } =>
              Boolean(i.productId),
            )
            .map((i) => ({ productId: i.productId, quantity: i.quantity })),
        );
        // A coupon is consumed exactly when stock is reserved (COD at checkout,
        // online at capture) — so release it under the same condition.
        if (order.couponId) {
          await this.coupons.release(tx, order.couponId);
        }
      }

      // Cancel any still-outstanding (non-captured) payment intents.
      await tx.paymentTransaction.updateMany({
        where: {
          orderId: order.id,
          status: {
            in: [
              PaymentStatus.INITIATED,
              PaymentStatus.PENDING,
              PaymentStatus.COD_PENDING,
            ],
          },
        },
        data: { status: PaymentStatus.CANCELLED },
      });

      if (captured) {
        // Money is captured but the order is now cancelled → refund owed.
        await tx.order.update({
          where: { id: order.id },
          data: {
            needsReview: true,
            adminNotes: `${adminNotes ? adminNotes + ' | ' : ''}Cancelled ${
              byAdmin ? '(admin)' : '(customer)'
            } after payment capture on ${order.orderNumber} — refund required.`,
          },
        });
        this.logger.error(
          `REFUND REQUIRED: ${order.orderNumber} cancelled after payment capture`,
        );
      }

      return tx.order.findUniqueOrThrow({
        where: { id: order.id },
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
