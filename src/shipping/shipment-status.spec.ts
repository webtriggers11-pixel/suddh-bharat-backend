import { OrderStatus, ShipmentStatus } from '@prisma/client';
import {
  mapShipmentStatus,
  orderStatusForShipment,
  isForwardOrderTransition,
  shouldApplyShipmentStatus,
} from './shipment-status';

describe('shouldApplyShipmentStatus', () => {
  it('advances along the linear happy path', () => {
    expect(
      shouldApplyShipmentStatus(
        ShipmentStatus.LABEL_CREATED,
        ShipmentStatus.IN_TRANSIT,
      ),
    ).toBe(true);
  });

  it('never regresses (late pickup-exception after in-transit)', () => {
    expect(
      shouldApplyShipmentStatus(
        ShipmentStatus.IN_TRANSIT,
        ShipmentStatus.PICKUP_SCHEDULED,
      ),
    ).toBe(false);
  });

  it('always applies exceptional states (RTO / failed / cancelled)', () => {
    expect(
      shouldApplyShipmentStatus(
        ShipmentStatus.IN_TRANSIT,
        ShipmentStatus.RTO_INITIATED,
      ),
    ).toBe(true);
    expect(
      shouldApplyShipmentStatus(
        ShipmentStatus.OUT_FOR_DELIVERY,
        ShipmentStatus.DELIVERY_FAILED,
      ),
    ).toBe(true);
  });

  it('ignores a no-op (same status)', () => {
    expect(
      shouldApplyShipmentStatus(
        ShipmentStatus.DELIVERED,
        ShipmentStatus.DELIVERED,
      ),
    ).toBe(false);
  });
});

describe('mapShipmentStatus', () => {
  it('maps common courier phrases', () => {
    expect(mapShipmentStatus('In Transit')).toBe(ShipmentStatus.IN_TRANSIT);
    expect(mapShipmentStatus('Out For Delivery')).toBe(
      ShipmentStatus.OUT_FOR_DELIVERY,
    );
    expect(mapShipmentStatus('DELIVERED')).toBe(ShipmentStatus.DELIVERED);
    expect(mapShipmentStatus('Picked Up')).toBe(ShipmentStatus.PICKED_UP);
  });

  it('prefers the most specific match (rto delivered before delivered)', () => {
    expect(mapShipmentStatus('RTO Delivered')).toBe(
      ShipmentStatus.RTO_DELIVERED,
    );
    expect(mapShipmentStatus('RTO Initiated')).toBe(
      ShipmentStatus.RTO_INITIATED,
    );
  });

  it('returns null for unknown / empty', () => {
    expect(mapShipmentStatus('some noise')).toBeNull();
    expect(mapShipmentStatus('')).toBeNull();
    expect(mapShipmentStatus(null)).toBeNull();
  });
});

describe('orderStatusForShipment', () => {
  it('projects fulfilment milestones onto order status', () => {
    expect(orderStatusForShipment(ShipmentStatus.IN_TRANSIT)).toBe(
      OrderStatus.SHIPPED,
    );
    expect(orderStatusForShipment(ShipmentStatus.OUT_FOR_DELIVERY)).toBe(
      OrderStatus.OUT_FOR_DELIVERY,
    );
    expect(orderStatusForShipment(ShipmentStatus.DELIVERED)).toBe(
      OrderStatus.DELIVERED,
    );
    expect(orderStatusForShipment(ShipmentStatus.LABEL_CREATED)).toBeNull();
  });
});

describe('isForwardOrderTransition', () => {
  it('allows forward moves only', () => {
    expect(
      isForwardOrderTransition(OrderStatus.PROCESSING, OrderStatus.SHIPPED),
    ).toBe(true);
    expect(
      isForwardOrderTransition(OrderStatus.SHIPPED, OrderStatus.DELIVERED),
    ).toBe(true);
  });

  it('rejects regressions and self-moves', () => {
    expect(
      isForwardOrderTransition(OrderStatus.DELIVERED, OrderStatus.SHIPPED),
    ).toBe(false);
    expect(
      isForwardOrderTransition(OrderStatus.SHIPPED, OrderStatus.SHIPPED),
    ).toBe(false);
  });

  it('rejects transitions involving unranked states', () => {
    expect(
      isForwardOrderTransition(OrderStatus.CANCELLED, OrderStatus.DELIVERED),
    ).toBe(false);
  });
});
