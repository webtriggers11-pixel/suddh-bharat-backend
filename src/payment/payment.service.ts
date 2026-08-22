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
import { reserveStock } from '../common/stock';
import { RevalidateService } from '../common/revalidate.service';
import { CouponsService } from '../coupons/coupons.service';
import { RazorpayClient } from './razorpay.client';
import { InitiatePaymentDto, VerifyPaymentDto } from './dto/payment.dto';

/** Non-terminal payment states a retry may reuse. */
const REUSABLE_STATUSES: PaymentStatus[] = [
  PaymentStatus.INITIATED,
  PaymentStatus.PENDING,
];

export interface PaymentOrderResponse {
  razorpayOrderId: string;
  gatewayOrderId: string;
  keyId: string;
  amountPaise: number;
  currency: string;
  orderNumber: string;
  transactionId: string;
}

const ORDER_INCLUDE = {
  items: true,
  payments: { orderBy: { createdAt: 'desc' as const } },
} satisfies Prisma.OrderInclude;

/**
 * Razorpay payment orchestration (ADR-0011). `initiate` creates a gateway order
 * for a PENDING online order; `verify` validates the callback signature and
 * advances the order to PLACED. COD is handled entirely in checkout. Idempotent
 * on both ends so a double-submit or a retried webhook never double-charges or
 * corrupts state.
 */
@Injectable()
export class PaymentService {
  private readonly logger = new Logger(PaymentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly razorpay: RazorpayClient,
    private readonly revalidate: RevalidateService,
    private readonly coupons: CouponsService,
  ) {}

  async initiate(
    userId: string,
    dto: InitiatePaymentDto,
  ): Promise<PaymentOrderResponse> {
    const order = await this.prisma.order.findFirst({
      where: { id: dto.orderId, userId, deletedAt: null },
      include: ORDER_INCLUDE,
    });
    if (!order) throw new NotFoundException('Order not found');

    if (order.paymentMethod === PaymentMethod.COD) {
      throw new BadRequestException('COD orders do not require online payment');
    }
    if (order.status === OrderStatus.CANCELLED) {
      throw new BadRequestException('This order has been cancelled');
    }
    // Anything past PENDING means it was already paid/placed.
    if (order.status !== OrderStatus.PENDING) {
      throw new ConflictException('This order has already been paid');
    }
    if (order.totalMinor < 100) {
      throw new BadRequestException(
        'Order amount is below the payable minimum',
      );
    }

    // Reuse an in-flight transaction, else open a fresh retry attempt.
    const reusable = order.payments.find((p) =>
      REUSABLE_STATUSES.includes(p.status),
    );
    const attempt = reusable
      ? reusable.attempt
      : (order.payments[0]?.attempt ?? 0) + 1;

    const rzpOrder = await this.razorpay.createOrder(
      order.totalMinor, // totalMinor is already paise
      order.orderNumber,
    );

    let txn: { id: string };
    if (reusable) {
      txn = await this.prisma.paymentTransaction.update({
        where: { id: reusable.id },
        data: {
          status: PaymentStatus.PENDING,
          gatewayOrderId: rzpOrder.id,
          amountMinor: order.totalMinor,
        },
      });
    } else {
      try {
        txn = await this.prisma.paymentTransaction.create({
          data: {
            orderId: order.id,
            method: order.paymentMethod,
            amountMinor: order.totalMinor,
            status: PaymentStatus.PENDING,
            gatewayOrderId: rzpOrder.id,
            attempt,
          },
        });
      } catch (e) {
        // Concurrent initiate created the same attempt first (@@unique) — reuse
        // its row instead of inserting a duplicate. This one's gateway order is
        // an unpaid orphan (harmless); return the row that actually persisted.
        if (
          e instanceof Prisma.PrismaClientKnownRequestError &&
          e.code === 'P2002'
        ) {
          txn = await this.prisma.paymentTransaction.findFirstOrThrow({
            where: { orderId: order.id, attempt },
          });
        } else {
          throw e;
        }
      }
    }

    return {
      razorpayOrderId: rzpOrder.id,
      gatewayOrderId: rzpOrder.id,
      keyId: this.razorpay.publicKeyId(),
      amountPaise: order.totalMinor,
      currency: 'INR',
      orderNumber: order.orderNumber,
      transactionId: txn.id,
    };
  }

  async verify(userId: string, dto: VerifyPaymentDto) {
    const order = await this.prisma.order.findFirst({
      where: { id: dto.orderId, userId, deletedAt: null },
      include: ORDER_INCLUDE,
    });
    if (!order) throw new NotFoundException('Order not found');

    // Idempotency: already-verified payment for this gateway order → return as-is.
    const already = order.payments.find(
      (p) =>
        p.gatewayOrderId === dto.razorpayOrderId &&
        p.status === PaymentStatus.SUCCESS,
    );
    if (already) return this.reload(order.id);

    const txn = order.payments.find(
      (p) => p.gatewayOrderId === dto.razorpayOrderId,
    );
    if (!txn) {
      throw new BadRequestException('No payment initiated for this order');
    }

    const valid = this.razorpay.verifySignature(
      dto.razorpayOrderId,
      dto.razorpayPaymentId,
      dto.razorpaySignature,
    );

    if (!valid) {
      await this.prisma.paymentTransaction.update({
        where: { id: txn.id },
        data: {
          status: PaymentStatus.FAILED,
          failureReason: 'Signature verification failed',
          failedAt: new Date(),
          gatewayPaymentId: dto.razorpayPaymentId,
        },
      });
      this.logger.warn(
        `Payment signature mismatch for order ${order.orderNumber} (txn ${txn.id})`,
      );
      throw new BadRequestException('Payment verification failed');
    }

    await this.commitCapture(order, txn, dto.razorpayPaymentId, {
      signature: dto.razorpaySignature,
      source: 'checkout',
    });

    // Stock changed → bust the storefront product cache so it's fresh immediately.
    this.revalidate.revalidate(['products']);
    return this.reload(order.id);
  }

  /**
   * Provider-side settlement fallback (Razorpay webhook). If the shopper closes
   * the tab before the browser calls `/payment/verify`, the money is still
   * captured — the webhook is the ONLY way we hear about it. Looks the payment
   * up by its gateway order id (already signature-verified by the webhook
   * handler), and runs the exact same idempotent capture as `verify`.
   */
  async settleByGatewayOrder(
    gatewayOrderId: string,
    paymentId: string,
  ): Promise<{ handled: boolean; already?: boolean }> {
    const txn = await this.prisma.paymentTransaction.findUnique({
      where: { gatewayOrderId },
    });
    if (!txn) {
      this.logger.warn(
        `Razorpay webhook for unknown gateway order ${gatewayOrderId} — ignored`,
      );
      return { handled: false };
    }
    if (txn.status === PaymentStatus.SUCCESS) {
      return { handled: true, already: true }; // verify() already settled it
    }
    const order = await this.prisma.order.findUnique({
      where: { id: txn.orderId },
      include: ORDER_INCLUDE,
    });
    if (!order) {
      this.logger.error(
        `Razorpay webhook: txn ${txn.id} has no order ${txn.orderId}`,
      );
      return { handled: false };
    }
    await this.commitCapture(order, txn, paymentId, { source: 'webhook' });
    this.revalidate.revalidate(['products']);
    return { handled: true };
  }

  /**
   * Idempotent success path shared by the checkout callback and the webhook.
   * Advances the order PENDING → PLACED via compare-and-swap, records the
   * capture, and — only on the ONE call that wins the transition — runs the
   * deferred side effects (reserve stock, consume coupon, lock address, clear
   * cart). A capture that lands on a non-PENDING order is flagged for refund.
   */
  private async commitCapture(
    order: {
      id: string;
      orderNumber: string;
      userId: string;
      addressId: string | null;
      couponId: string | null;
      items: { productId: string | null; quantity: number }[];
    },
    txn: { id: string; gatewayOrderId: string | null },
    paymentId: string,
    meta: { signature?: string; source: 'checkout' | 'webhook' },
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const now = new Date();
      const moved = await tx.order.updateMany({
        where: { id: order.id, status: OrderStatus.PENDING },
        data: { status: OrderStatus.PLACED, placedAt: now },
      });

      // Always record the capture (money left the customer regardless).
      await tx.paymentTransaction.update({
        where: { id: txn.id },
        data: {
          status: PaymentStatus.SUCCESS,
          gatewayPaymentId: paymentId,
          gatewaySignature: meta.signature ?? meta.source,
          completedAt: now,
          gatewayResponse: JSON.stringify({
            razorpay_order_id: txn.gatewayOrderId,
            razorpay_payment_id: paymentId,
            source: meta.source,
          }),
        },
      });

      if (moved.count !== 1) {
        // The order was NOT PENDING when the payment landed. Already PLACED is a
        // benign double-settle (verify + webhook); anything else (e.g. CANCELLED)
        // means the customer paid for a dead order → flag a refund.
        const cur = await tx.order.findUnique({
          where: { id: order.id },
          select: { status: true },
        });
        if (cur && cur.status !== OrderStatus.PLACED) {
          await tx.order.update({
            where: { id: order.id },
            data: {
              needsReview: true,
              adminNotes: `Payment ${paymentId} captured (${meta.source}) after order left PENDING (was ${cur.status}) — refund required.`,
            },
          });
          this.logger.error(
            `REFUND REQUIRED: payment ${paymentId} captured on ${order.orderNumber} which is ${cur.status}`,
          );
        }
        return;
      }

      // Reserve stock now — one atomic, conditional statement. Payment already
      // succeeded, so a shortfall is flagged for review + refund, not thrown
      // (never roll back a captured sale silently).
      const lines = order.items
        .filter((i): i is { productId: string; quantity: number } =>
          Boolean(i.productId),
        )
        .map((i) => ({ productId: i.productId, quantity: i.quantity }));
      const allReserved = await reserveStock(tx, lines);
      const oversold = !allReserved;
      if (oversold) {
        this.logger.error(
          `OVERSOLD: order ${order.orderNumber} — one or more items short of stock at payment; needs review`,
        );
      }

      // Consume the coupon now (online defers it from checkout to capture, so an
      // abandoned payment never drained the usage limit). Soft-fail: the discount
      // was already granted, so a limit race is logged, not thrown.
      if (order.couponId) {
        const consumed = await this.coupons.consume(tx, order.couponId);
        if (!consumed) {
          this.logger.warn(
            `Coupon ${order.couponId} could not be consumed at capture for ${order.orderNumber} (limit race)`,
          );
        }
      }

      if (order.addressId) {
        await tx.address.updateMany({
          where: { id: order.addressId },
          data: { isLocked: true },
        });
      }
      await tx.cartItem.deleteMany({ where: { userId: order.userId } });
      if (oversold) {
        await tx.order.update({
          where: { id: order.id },
          data: {
            needsReview: true,
            adminNotes:
              'One or more items were out of stock at payment — review / partial refund.',
          },
        });
      }
    });
  }

  private reload(orderId: string) {
    return this.prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      include: ORDER_INCLUDE,
    });
  }
}
