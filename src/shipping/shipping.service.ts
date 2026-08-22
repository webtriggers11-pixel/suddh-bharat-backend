import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  OrderStatus,
  PaymentMethod,
  Prisma,
  ShipmentStatus,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { StoreConfigService } from '../store-config/store-config.service';
import { ShiprocketClient, RawTrackActivity } from './shiprocket.client';
import {
  mapShipmentStatus,
  shouldApplyShipmentStatus,
} from './shipment-status';

/** A shippable package (server-computed; never trusted from the client). */
export interface PackageInfo {
  weightKg: number;
  lengthCm: number;
  breadthCm: number;
  heightCm: number;
}

/** A server-authoritative shipping quote in integer paise. */
export interface ShippingQuote {
  courierId: string | null;
  courierName: string;
  rateMinor: number;
  estimatedDays: number;
  estimatedDelivery: string; // ISO
}

const DEFAULT_WEIGHT_KG = 0.5;
const DEFAULT_DIMS = { lengthCm: 10, breadthCm: 10, heightCm: 5 };

@Injectable()
export class ShippingService {
  private readonly logger = new Logger(ShippingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly store: StoreConfigService,
    private readonly shiprocket: ShiprocketClient,
  ) {}

  // ---- Package building ------------------------------------------------------

  /** Build a package from arbitrary (product-like) lines. */
  buildPackage(
    lines: {
      weightKg: number | null;
      lengthCm: number | null;
      breadthCm: number | null;
      heightCm: number | null;
      quantity: number;
    }[],
  ): PackageInfo {
    let weightKg = 0;
    let lengthCm = DEFAULT_DIMS.lengthCm;
    let breadthCm = DEFAULT_DIMS.breadthCm;
    let heightCm = DEFAULT_DIMS.heightCm;
    for (const l of lines) {
      const qty = Math.max(1, l.quantity);
      weightKg += (l.weightKg ?? DEFAULT_WEIGHT_KG) * qty;
      lengthCm = Math.max(lengthCm, l.lengthCm ?? 0);
      breadthCm = Math.max(breadthCm, l.breadthCm ?? 0);
      heightCm = Math.max(heightCm, l.heightCm ?? 0);
    }
    // Guard against a zero/negative package (e.g. empty lines).
    weightKg = Math.max(DEFAULT_WEIGHT_KG, Math.round(weightKg * 1000) / 1000);
    return { weightKg, lengthCm, breadthCm, heightCm };
  }

  // ---- Live rate -------------------------------------------------------------

  /**
   * Cheapest serviceable courier for a delivery pincode. Throws if Shiprocket is
   * unreachable / not serviceable — callers at checkout catch and fall back.
   */
  async getLiveRate(
    deliveryPincode: string,
    pkg: PackageInfo,
    cod: boolean,
  ): Promise<ShippingQuote> {
    const pickup = this.store.pickup();
    if (!pickup.pincode) {
      throw new ServiceUnavailableException(
        'Store pickup pincode is not configured',
      );
    }
    if (!/^\d{6}$/.test(deliveryPincode)) {
      throw new BadRequestException(
        'A valid 6-digit delivery pincode is required',
      );
    }
    const couriers = await this.shiprocket.serviceability({
      pickupPincode: pickup.pincode,
      deliveryPincode,
      weightKg: pkg.weightKg,
      cod,
      lengthCm: pkg.lengthCm,
      breadthCm: pkg.breadthCm,
      heightCm: pkg.heightCm,
    });
    const cheapest = couriers[0]; // serviceability() returns cheapest-first
    const eta = cheapest.estimatedDays;
    const estimatedDelivery = new Date(
      Date.now() + eta * 24 * 60 * 60 * 1000,
    ).toISOString();
    return {
      courierId: cheapest.courierId,
      courierName: cheapest.courierName,
      rateMinor: Math.round(cheapest.rate * 100),
      estimatedDays: eta,
      estimatedDelivery,
    };
  }

  /** Rate for the authenticated user's current cart. */
  async getRatesForCart(
    userId: string,
    pincode: string,
  ): Promise<ShippingQuote> {
    const items = await this.prisma.cartItem.findMany({
      where: { userId },
      include: {
        product: {
          select: {
            weightKg: true,
            lengthCm: true,
            breadthCm: true,
            heightCm: true,
          },
        },
      },
    });
    if (items.length === 0) throw new BadRequestException('Your cart is empty');
    const pkg = this.buildPackage(
      items.map((i) => ({ ...i.product, quantity: i.quantity })),
    );
    return this.getLiveRate(pincode, pkg, false);
  }

  /** Public single-product estimate. */
  async getEstimateForProduct(
    productId: string,
    pincode: string,
  ): Promise<ShippingQuote> {
    const product = await this.prisma.product.findFirst({
      where: { id: productId, isActive: true, deletedAt: null },
      select: {
        weightKg: true,
        lengthCm: true,
        breadthCm: true,
        heightCm: true,
      },
    });
    if (!product) throw new NotFoundException('Product not found');
    const pkg = this.buildPackage([{ ...product, quantity: 1 }]);
    return this.getLiveRate(pincode, pkg, false);
  }

  // ---- Booking ---------------------------------------------------------------

  private orderInclude = {
    items: true,
    payments: { orderBy: { createdAt: 'desc' as const } },
    shipment: {
      include: { trackingEvents: { orderBy: { eventTime: 'asc' as const } } },
    },
  } satisfies Prisma.OrderInclude;

  /**
   * Book a Shiprocket shipment for a confirmed/processing order. Idempotent-ish:
   * an order that already has an AWB is rejected (409); one whose booking exists
   * but has no AWB yet just retries the AWB assignment (recovers a half-booking).
   */
  async createShipment(orderId: string) {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, deletedAt: null },
      include: this.orderInclude,
    });
    if (!order) throw new NotFoundException('Order not found');
    if (
      order.status !== OrderStatus.CONFIRMED &&
      order.status !== OrderStatus.PROCESSING
    ) {
      throw new BadRequestException(
        `Order must be confirmed before a shipment can be booked (is ${order.status})`,
      );
    }
    if (order.shipment?.awbNumber) {
      throw new ConflictException('This order already has a booked shipment');
    }

    const cod = order.payments.some((p) => p.method === PaymentMethod.COD);
    const pkg = this.buildPackage(
      order.items.map((it) => ({
        // OrderItem does not snapshot dims; fall back to defaults per unit.
        weightKg: null,
        lengthCm: null,
        breadthCm: null,
        heightCm: null,
        quantity: it.quantity,
      })),
    );
    const pickup = this.store.pickup();

    // Reuse an existing half-booking if present, else create the SR order.
    let shiprocketOrderId = order.shipment?.shiprocketOrderId ?? null;
    let shiprocketShipmentId = order.shipment?.shiprocketShipmentId ?? null;

    if (!shiprocketShipmentId) {
      const created = await this.shiprocket.createAdhocOrder({
        orderId: order.orderNumber,
        orderDate: formatSrDate(order.createdAt),
        pickupLocation: pickup.location,
        billingName: order.shipName,
        billingAddress: [order.shipLine1, order.shipLine2]
          .filter(Boolean)
          .join(', '),
        billingCity: order.shipCity,
        billingState: order.shipState,
        billingPincode: order.shipPincode,
        billingPhone: order.shipPhone,
        billingEmail: order.shipEmail ?? undefined,
        paymentMethod: cod ? 'COD' : 'Prepaid',
        subTotal: order.subtotalMinor / 100,
        lengthCm: pkg.lengthCm,
        breadthCm: pkg.breadthCm,
        heightCm: pkg.heightCm,
        weightKg: pkg.weightKg,
        items: order.items.map((it) => ({
          name: it.productName,
          sku: it.productSlug ?? it.productId ?? it.id,
          units: it.quantity,
          sellingPrice: it.unitPriceMinor / 100,
        })),
      });
      shiprocketOrderId = created.shiprocketOrderId;
      shiprocketShipmentId = created.shiprocketShipmentId;

      // Persist the half-booking immediately so a later AWB failure is recoverable.
      await this.prisma.$transaction(async (tx) => {
        await tx.shipmentDetail.upsert({
          where: { orderId: order.id },
          create: {
            orderId: order.id,
            provider: 'shiprocket',
            shiprocketOrderId,
            shiprocketShipmentId,
            status: ShipmentStatus.LABEL_CREATED,
            shippingCostChargedMinor: order.shippingMinor,
            packageWeightKg: pkg.weightKg,
            packageLengthCm: pkg.lengthCm,
            packageBreadthCm: pkg.breadthCm,
            packageHeightCm: pkg.heightCm,
            labelGeneratedAt: new Date(),
          },
          update: { shiprocketOrderId, shiprocketShipmentId },
        });
        if (order.status === OrderStatus.CONFIRMED) {
          await tx.order.update({
            where: { id: order.id },
            data: { status: OrderStatus.PROCESSING },
          });
        }
      });
    }

    // Assign the AWB (retryable step).
    const awb = await this.shiprocket.assignAwb(shiprocketShipmentId);
    const trackingUrl = `https://shiprocket.co/tracking/${awb.awbCode}`;
    await this.prisma.shipmentDetail.update({
      where: { orderId: order.id },
      data: {
        awbNumber: awb.awbCode,
        courierId: awb.courierId,
        courierName: awb.courierName,
        trackingUrl,
      },
    });

    return this.getShipment(orderId);
  }

  /** Fetch stored shipment (no live call). Optional ownership enforcement. */
  async getShipment(orderId: string, ownerUserId?: string) {
    const order = await this.prisma.order.findFirst({
      where: {
        id: orderId,
        deletedAt: null,
        ...(ownerUserId ? { userId: ownerUserId } : {}),
      },
      select: {
        id: true,
        shipment: {
          include: { trackingEvents: { orderBy: { eventTime: 'asc' } } },
        },
      },
    });
    if (!order) throw new NotFoundException('Order not found');
    if (!order.shipment)
      throw new NotFoundException('No shipment for this order');
    return order.shipment;
  }

  /** Pull the latest tracking from Shiprocket and persist new events. */
  async syncTracking(orderId: string, ownerUserId?: string) {
    const shipment = await this.getShipment(orderId, ownerUserId);
    if (!shipment.awbNumber) {
      throw new BadRequestException('Shipment has no AWB yet');
    }
    const activities = await this.shiprocket.trackAwb(shipment.awbNumber);
    await this.persistTracking(shipment.id, shipment.status, activities);
    // Re-read with fresh events.
    return this.prisma.shipmentDetail.findUniqueOrThrow({
      where: { id: shipment.id },
      include: { trackingEvents: { orderBy: { eventTime: 'asc' } } },
    });
  }

  /**
   * Insert new tracking events (deduped by eventTime) and advance the shipment's
   * denormalized status. Reused by the webhook handler. Runs in one transaction.
   */
  async persistTracking(
    shipmentId: string,
    currentStatus: ShipmentStatus,
    activities: RawTrackActivity[],
  ): Promise<ShipmentStatus> {
    const existing = await this.prisma.shipmentTracking.findMany({
      where: { shipmentId },
      select: { eventTime: true },
    });
    const seen = new Set(existing.map((e) => e.eventTime.getTime()));

    const rows: Prisma.ShipmentTrackingCreateManyInput[] = [];
    // Pick the most-advanced status in the batch (forward-only), never the
    // time-latest — a late backward scan must not regress the shipment (F3).
    let latestStatus = currentStatus;

    for (const a of activities) {
      const when = a.date ? new Date(a.date) : null;
      if (!when || Number.isNaN(when.getTime())) continue;
      const key = when.getTime();
      const rawStatus = a['sr-status-label'] ?? a.status ?? a.activity ?? '';
      if (!seen.has(key)) {
        seen.add(key);
        rows.push({
          shipmentId,
          status: String(rawStatus).slice(0, 100),
          description: a.activity ?? null,
          location: a.location ?? null,
          eventTime: when,
        });
      }
      const mapped = mapShipmentStatus(rawStatus);
      if (mapped && shouldApplyShipmentStatus(latestStatus, mapped)) {
        latestStatus = mapped;
      }
    }

    if (rows.length === 0 && latestStatus === currentStatus)
      return currentStatus;

    await this.prisma.$transaction(async (tx) => {
      if (rows.length > 0) {
        await tx.shipmentTracking.createMany({
          data: rows,
          skipDuplicates: true,
        });
      }
      if (latestStatus !== currentStatus) {
        // Compare-and-swap on the observed status so a concurrent webhook that
        // already advanced the shipment further is not overwritten.
        await tx.shipmentDetail.updateMany({
          where: { id: shipmentId, status: currentStatus },
          data: {
            status: latestStatus,
            ...(latestStatus === ShipmentStatus.DELIVERED
              ? { deliveredAt: new Date() }
              : {}),
            ...(latestStatus === ShipmentStatus.PICKED_UP
              ? { pickedUpAt: new Date() }
              : {}),
          },
        });
      }
    });
    return latestStatus;
  }

  /** Schedule a pickup for a booked shipment. */
  async schedulePickup(orderId: string, pickupDate?: string) {
    const shipment = await this.getShipment(orderId);
    if (!shipment.shiprocketShipmentId) {
      throw new BadRequestException('Shipment is not booked yet');
    }
    if (shipment.pickupScheduledAt) {
      throw new ConflictException('Pickup is already scheduled');
    }
    if (pickupDate && !/^\d{4}-\d{2}-\d{2}$/.test(pickupDate)) {
      throw new BadRequestException('pickupDate must be YYYY-MM-DD');
    }
    await this.shiprocket.generatePickup(
      shipment.shiprocketShipmentId,
      pickupDate,
    );
    return this.prisma.shipmentDetail.update({
      where: { id: shipment.id },
      data: {
        status: ShipmentStatus.PICKUP_SCHEDULED,
        pickupScheduledAt: new Date(),
      },
      include: { trackingEvents: { orderBy: { eventTime: 'asc' } } },
    });
  }
}

/** Shiprocket wants `"YYYY-MM-DD HH:mm"`. */
export function formatSrDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
