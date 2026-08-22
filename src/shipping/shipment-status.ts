import { OrderStatus, ShipmentStatus } from '@prisma/client';

/**
 * Fuzzy-map a raw courier status string onto our ShipmentStatus enum. Ordered
 * most-specific first (e.g. "rto delivered" before "delivered"). Shared by the
 * tracking sync and the webhook handler so both classify identically.
 */
export function mapShipmentStatus(
  raw: string | null | undefined,
): ShipmentStatus | null {
  if (!raw) return null;
  const s = raw.toLowerCase();
  const table: [string, ShipmentStatus][] = [
    ['rto delivered', ShipmentStatus.RTO_DELIVERED],
    ['rto initiated', ShipmentStatus.RTO_INITIATED],
    ['rto', ShipmentStatus.RTO_INITIATED],
    ['out for delivery', ShipmentStatus.OUT_FOR_DELIVERY],
    ['delivered', ShipmentStatus.DELIVERED],
    ['undelivered', ShipmentStatus.DELIVERY_FAILED],
    ['delivery failed', ShipmentStatus.DELIVERY_FAILED],
    ['in transit', ShipmentStatus.IN_TRANSIT],
    ['transit', ShipmentStatus.IN_TRANSIT],
    ['out for pickup', ShipmentStatus.PICKUP_SCHEDULED],
    ['pickup scheduled', ShipmentStatus.PICKUP_SCHEDULED],
    ['pickup generated', ShipmentStatus.PICKUP_SCHEDULED],
    ['picked up', ShipmentStatus.PICKED_UP],
    ['pickup exception', ShipmentStatus.PICKUP_SCHEDULED],
    ['cancelled', ShipmentStatus.CANCELLED],
    ['canceled', ShipmentStatus.CANCELLED],
    ['label created', ShipmentStatus.LABEL_CREATED],
  ];
  for (const [needle, status] of table) {
    if (s.includes(needle)) return status;
  }
  return null;
}

/**
 * Forward-only rank for the shipment's own status axis. The happy path is linear;
 * exceptional states (RTO / failed / cancelled) are meaningful even "out of order"
 * and always apply. Prevents a late "pickup exception" scan from regressing a
 * shipment that is already IN_TRANSIT (webhook F3).
 */
const SHIPMENT_RANK: Record<ShipmentStatus, number> = {
  [ShipmentStatus.NOT_CREATED]: 0,
  [ShipmentStatus.LABEL_CREATED]: 1,
  [ShipmentStatus.PICKUP_SCHEDULED]: 2,
  [ShipmentStatus.PICKED_UP]: 3,
  [ShipmentStatus.IN_TRANSIT]: 4,
  [ShipmentStatus.OUT_FOR_DELIVERY]: 5,
  [ShipmentStatus.DELIVERED]: 6,
  [ShipmentStatus.DELIVERY_FAILED]: 5,
  [ShipmentStatus.RTO_INITIATED]: 6,
  [ShipmentStatus.RTO_DELIVERED]: 7,
  [ShipmentStatus.CANCELLED]: 7,
};

const EXCEPTIONAL_SHIPMENT_STATES: ShipmentStatus[] = [
  ShipmentStatus.RTO_INITIATED,
  ShipmentStatus.RTO_DELIVERED,
  ShipmentStatus.DELIVERY_FAILED,
  ShipmentStatus.CANCELLED,
];

/** True if `next` should replace `current` on the shipment status axis. */
export function shouldApplyShipmentStatus(
  current: ShipmentStatus,
  next: ShipmentStatus,
): boolean {
  if (next === current) return false;
  if (EXCEPTIONAL_SHIPMENT_STATES.includes(next)) return true;
  return SHIPMENT_RANK[next] > SHIPMENT_RANK[current];
}

/**
 * Forward-only rank for order status. A tracking update may only advance the
 * order along the fulfilment axis, never regress it (a late "in transit" scan
 * must not un-deliver an order). Terminal/refund states are not reachable here.
 */
const ORDER_RANK: Partial<Record<OrderStatus, number>> = {
  [OrderStatus.PENDING]: 0,
  [OrderStatus.PLACED]: 1,
  [OrderStatus.CONFIRMED]: 2,
  [OrderStatus.PROCESSING]: 3,
  [OrderStatus.SHIPPED]: 4,
  [OrderStatus.OUT_FOR_DELIVERY]: 5,
  [OrderStatus.DELIVERED]: 6,
};

/** Which order status (if any) a shipment status should push the order toward. */
export function orderStatusForShipment(
  shipment: ShipmentStatus,
): OrderStatus | null {
  switch (shipment) {
    case ShipmentStatus.IN_TRANSIT:
    case ShipmentStatus.PICKED_UP:
      return OrderStatus.SHIPPED;
    case ShipmentStatus.OUT_FOR_DELIVERY:
      return OrderStatus.OUT_FOR_DELIVERY;
    case ShipmentStatus.DELIVERED:
      return OrderStatus.DELIVERED;
    default:
      return null;
  }
}

/** True if `next` is strictly forward of `current` on the fulfilment axis. */
export function isForwardOrderTransition(
  current: OrderStatus,
  next: OrderStatus,
): boolean {
  const c = ORDER_RANK[current];
  const n = ORDER_RANK[next];
  if (c === undefined || n === undefined) return false;
  return n > c;
}
