import { Injectable, Logger } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import { OrderStatus, PaymentStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { StoreConfigService } from '../store-config/store-config.service';
import { ShippingService } from '../shipping/shipping.service';
import {
  ShiprocketClient,
  RawTrackActivity,
} from '../shipping/shiprocket.client';
import { RazorpayClient } from '../payment/razorpay.client';
import { PaymentService } from '../payment/payment.service';
import {
  isForwardOrderTransition,
  orderStatusForShipment,
} from '../shipping/shipment-status';

export interface WebhookResult {
  received: boolean;
  reason?: string;
}

/**
 * Shiprocket webhook processing. Authenticates via a shared secret, maps the
 * event onto a shipment/order, and advances state forward-only. The controller
 * ALWAYS returns 200 (even on auth failure) to avoid provider retry storms —
 * real security is enforced at the infra/IP layer too.
 */
@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly store: StoreConfigService,
    private readonly shipping: ShippingService,
    private readonly shiprocket: ShiprocketClient,
    private readonly razorpay: RazorpayClient,
    private readonly payment: PaymentService,
  ) {}

  /**
   * Razorpay webhook — the settlement fallback when the shopper never returns to
   * call /payment/verify (closed tab, lost network). Verifies the HMAC over the
   * RAW body, then settles the captured payment idempotently. Only cares about
   * capture events; everything else is acknowledged and ignored.
   */
  async handleRazorpay(
    signature: string | undefined,
    rawBody: string,
    body: Record<string, unknown>,
  ): Promise<WebhookResult> {
    if (!this.razorpay.verifyWebhookSignature(rawBody, signature)) {
      this.logger.warn('Razorpay webhook rejected: bad signature');
      return { received: false, reason: 'unauthorized' };
    }

    const event = typeof body.event === 'string' ? body.event : '';
    if (event !== 'payment.captured' && event !== 'order.paid') {
      return { received: true, reason: `ignored:${event || 'unknown'}` };
    }

    const entity = extractRazorpayPayment(body);
    if (!entity?.orderId || !entity.paymentId) {
      this.logger.warn(`Razorpay webhook ${event}: missing order/payment id`);
      return { received: false, reason: 'incomplete' };
    }

    const result = await this.payment.settleByGatewayOrder(
      entity.orderId,
      entity.paymentId,
    );
    return {
      received: result.handled,
      reason: result.already ? 'already' : event,
    };
  }

  private tokenOk(incoming: string | undefined): boolean {
    const secret = this.store.shiprocketWebhookSecret();
    if (!secret) return false;
    if (!incoming) return false;
    const a = Buffer.from(incoming, 'utf8');
    const b = Buffer.from(secret, 'utf8');
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  async handleShiprocket(
    token: string | undefined,
    body: Record<string, unknown>,
  ): Promise<WebhookResult> {
    if (!this.tokenOk(token)) {
      this.logger.warn('Shiprocket webhook rejected: bad token');
      return { received: false, reason: 'unauthorized' };
    }

    const awb = pickString(body, ['awb', 'awb_code']);
    if (!awb) return { received: false, reason: 'no awb' };

    const shipment = await this.prisma.shipmentDetail.findFirst({
      where: { awbNumber: awb },
      select: { id: true, status: true, orderId: true, courierName: true },
    });
    if (!shipment) {
      this.logger.warn(`Shiprocket webhook: no shipment for awb ${awb}`);
      return { received: false, reason: 'unknown awb' };
    }

    // Build an activity list from the webhook payload (single event or array).
    const activities = extractActivities(body);
    const latestStatus = await this.shipping.persistTracking(
      shipment.id,
      shipment.status,
      activities,
    );

    // Fill courier name if we did not have it yet.
    const courierName = pickString(body, ['courier_name']);
    if (courierName && !shipment.courierName) {
      await this.prisma.shipmentDetail.update({
        where: { id: shipment.id },
        data: { courierName },
      });
    }

    await this.advanceOrder(shipment.orderId, latestStatus);
    return { received: true };
  }

  /** Advance the order forward-only, with delivered-side effects. */
  private async advanceOrder(
    orderId: string,
    shipmentStatus: import('@prisma/client').ShipmentStatus,
  ): Promise<void> {
    const target = orderStatusForShipment(shipmentStatus);
    if (!target) return;

    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: { id: true, status: true },
    });
    if (!order) return;
    if (!isForwardOrderTransition(order.status, target)) return;

    await this.prisma.$transaction(async (tx) => {
      // Compare-and-swap on the observed status: if a concurrent webhook already
      // advanced the order (e.g. to DELIVERED), this matches 0 rows and we skip
      // the side effects — a late SHIPPED event can never regress DELIVERED.
      const res = await tx.order.updateMany({
        where: { id: order.id, status: order.status },
        data: {
          status: target,
          ...(target === OrderStatus.SHIPPED ? { shippedAt: new Date() } : {}),
          ...(target === OrderStatus.DELIVERED
            ? { deliveredAt: new Date() }
            : {}),
        },
      });
      if (res.count === 0) return; // lost the race — another writer moved it
      if (target === OrderStatus.DELIVERED) {
        // COD collected on delivery.
        await tx.paymentTransaction.updateMany({
          where: { orderId: order.id, status: PaymentStatus.COD_PENDING },
          data: {
            status: PaymentStatus.COD_COLLECTED,
            completedAt: new Date(),
          },
        });
      }
    });
  }

  /** Register the webhook URL with Shiprocket; returns the issued secret (if any). */
  async register(webhookUrl: string): Promise<{ secret: string | null }> {
    return this.shiprocket.registerWebhook(webhookUrl);
  }
}

function pickString(
  body: Record<string, unknown>,
  keys: string[],
): string | null {
  for (const k of keys) {
    const v = body[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number') return String(v);
  }
  return null;
}

/**
 * Normalise a Shiprocket webhook body into tracking activities. Shiprocket sends
 * a flat `current_status` + `current_timestamp`, sometimes with a
 * `scans`/`shipment_track_activities` array — handle both.
 */
function extractActivities(body: Record<string, unknown>): RawTrackActivity[] {
  const out: RawTrackActivity[] = [];
  const arr =
    (body.shipment_track_activities as RawTrackActivity[] | undefined) ??
    (body.scans as RawTrackActivity[] | undefined);
  if (Array.isArray(arr)) {
    for (const a of arr) {
      out.push({
        date: (a as Record<string, unknown>).date as string | undefined,
        status:
          ((a as Record<string, unknown>)['sr-status-label'] as string) ??
          ((a as Record<string, unknown>).status as string) ??
          ((a as Record<string, unknown>).activity as string),
        activity: (a as Record<string, unknown>).activity as string | undefined,
        location: (a as Record<string, unknown>).location as string | undefined,
      });
    }
  }
  const current = pickString(body, ['current_status', 'shipment_status']);
  const when = pickString(body, [
    'current_timestamp',
    'status_time',
    'awb_assigned_date',
  ]);
  if (current) {
    out.push({
      date: when ?? new Date().toISOString(),
      status: current,
      activity: current,
      location: pickString(body, ['location']) ?? undefined,
    });
  }
  return out;
}

/**
 * Pull the gateway order id + payment id out of a Razorpay webhook payload.
 * `payment.captured` carries payload.payment.entity; `order.paid` carries both
 * payload.order.entity and payload.payment.entity.
 */
function extractRazorpayPayment(
  body: Record<string, unknown>,
): { orderId: string; paymentId: string } | null {
  const payload = body.payload as Record<string, unknown> | undefined;
  const payment = (payload?.payment as Record<string, unknown> | undefined)
    ?.entity as Record<string, unknown> | undefined;
  const orderId =
    (payment?.order_id as string | undefined) ??
    ((
      (payload?.order as Record<string, unknown> | undefined)?.entity as
        Record<string, unknown> | undefined
    )?.id as string | undefined);
  const paymentId = payment?.id as string | undefined;
  if (!orderId || !paymentId) return null;
  return { orderId, paymentId };
}
