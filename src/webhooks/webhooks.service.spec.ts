import { OrderStatus, PaymentStatus, ShipmentStatus } from '@prisma/client';
import { WebhooksService } from './webhooks.service';
import { PrismaService } from '../prisma/prisma.service';
import { StoreConfigService } from '../store-config/store-config.service';
import { ShippingService } from '../shipping/shipping.service';
import { ShiprocketClient } from '../shipping/shiprocket.client';
import { RazorpayClient } from '../payment/razorpay.client';
import { PaymentService } from '../payment/payment.service';

const SECRET = 'hook_secret';

describe('WebhooksService', () => {
  let prisma: {
    shipmentDetail: { findFirst: jest.Mock; update: jest.Mock };
    order: { findUnique: jest.Mock; update: jest.Mock };
    paymentTransaction: { updateMany: jest.Mock };
    $transaction: jest.Mock;
  };
  let store: { shiprocketWebhookSecret: jest.Mock };
  let shipping: { persistTracking: jest.Mock };
  let shiprocket: { registerWebhook: jest.Mock };
  let razorpay: { verifyWebhookSignature: jest.Mock };
  let payment: { settleByGatewayOrder: jest.Mock };
  let service: WebhooksService;
  let txOrderUpdate: jest.Mock;
  let txPayUpdateMany: jest.Mock;

  beforeEach(() => {
    txOrderUpdate = jest.fn().mockResolvedValue({ count: 1 });
    txPayUpdateMany = jest.fn();
    prisma = {
      shipmentDetail: {
        findFirst: jest.fn(),
        update: jest.fn(),
      },
      order: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      paymentTransaction: { updateMany: jest.fn() },
      $transaction: jest.fn(async (cb) =>
        cb({
          order: { updateMany: txOrderUpdate },
          paymentTransaction: { updateMany: txPayUpdateMany },
        }),
      ),
    };
    store = { shiprocketWebhookSecret: jest.fn().mockReturnValue(SECRET) };
    shipping = {
      persistTracking: jest.fn().mockResolvedValue(ShipmentStatus.IN_TRANSIT),
    };
    shiprocket = { registerWebhook: jest.fn() };
    razorpay = { verifyWebhookSignature: jest.fn().mockReturnValue(true) };
    payment = {
      settleByGatewayOrder: jest.fn().mockResolvedValue({ handled: true }),
    };
    service = new WebhooksService(
      prisma as unknown as PrismaService,
      store as unknown as StoreConfigService,
      shipping as unknown as ShippingService,
      shiprocket as unknown as ShiprocketClient,
      razorpay as unknown as RazorpayClient,
      payment as unknown as PaymentService,
    );
  });

  it('rejects a bad token (never throws)', async () => {
    const res = await service.handleShiprocket('wrong', { awb: 'A1' });
    expect(res).toEqual({ received: false, reason: 'unauthorized' });
    expect(prisma.shipmentDetail.findFirst).not.toHaveBeenCalled();
  });

  // ---- Razorpay webhook (capture fallback) ---------------------------------

  const capturedBody = {
    event: 'payment.captured',
    payload: {
      payment: { entity: { id: 'pay_9', order_id: 'order_9' } },
    },
  };

  it('rejects a Razorpay webhook with a bad signature (never settles)', async () => {
    razorpay.verifyWebhookSignature.mockReturnValue(false);
    const res = await service.handleRazorpay('sig', '{}', capturedBody);
    expect(res).toEqual({ received: false, reason: 'unauthorized' });
    expect(payment.settleByGatewayOrder).not.toHaveBeenCalled();
  });

  it('settles a captured payment by gateway order id', async () => {
    const res = await service.handleRazorpay('sig', 'raw', capturedBody);
    expect(payment.settleByGatewayOrder).toHaveBeenCalledWith(
      'order_9',
      'pay_9',
    );
    expect(res.received).toBe(true);
  });

  it('acknowledges and ignores non-capture Razorpay events', async () => {
    const res = await service.handleRazorpay('sig', 'raw', {
      event: 'payment.authorized',
      payload: {},
    });
    expect(res.received).toBe(true);
    expect(payment.settleByGatewayOrder).not.toHaveBeenCalled();
  });

  it('rejects when no secret is configured', async () => {
    store.shiprocketWebhookSecret.mockReturnValue(null);
    const res = await service.handleShiprocket(SECRET, { awb: 'A1' });
    expect(res.received).toBe(false);
  });

  it('reports when the payload has no awb', async () => {
    const res = await service.handleShiprocket(SECRET, {});
    expect(res).toEqual({ received: false, reason: 'no awb' });
  });

  it('reports an unknown awb', async () => {
    prisma.shipmentDetail.findFirst.mockResolvedValue(null);
    const res = await service.handleShiprocket(SECRET, { awb: 'A1' });
    expect(res).toEqual({ received: false, reason: 'unknown awb' });
  });

  it('advances the order forward-only on a valid event', async () => {
    prisma.shipmentDetail.findFirst.mockResolvedValue({
      id: 's1',
      status: ShipmentStatus.LABEL_CREATED,
      orderId: 'o1',
      courierName: 'A',
    });
    prisma.order.findUnique.mockResolvedValue({
      id: 'o1',
      status: OrderStatus.PROCESSING,
    });
    const res = await service.handleShiprocket(SECRET, {
      awb: 'A1',
      current_status: 'In Transit',
      current_timestamp: '2026-08-22 10:00',
    });
    expect(res).toEqual({ received: true });
    expect(txOrderUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: OrderStatus.SHIPPED }),
      }),
    );
  });

  it('does not regress an already-delivered order', async () => {
    prisma.shipmentDetail.findFirst.mockResolvedValue({
      id: 's1',
      status: ShipmentStatus.DELIVERED,
      orderId: 'o1',
      courierName: 'A',
    });
    prisma.order.findUnique.mockResolvedValue({
      id: 'o1',
      status: OrderStatus.DELIVERED,
    });
    shipping.persistTracking.mockResolvedValue(ShipmentStatus.IN_TRANSIT);
    await service.handleShiprocket(SECRET, {
      awb: 'A1',
      current_status: 'In Transit',
    });
    expect(txOrderUpdate).not.toHaveBeenCalled();
  });

  it('skips side effects when the CAS loses the race (count 0)', async () => {
    prisma.shipmentDetail.findFirst.mockResolvedValue({
      id: 's1',
      status: ShipmentStatus.OUT_FOR_DELIVERY,
      orderId: 'o1',
      courierName: 'A',
    });
    prisma.order.findUnique.mockResolvedValue({
      id: 'o1',
      status: OrderStatus.OUT_FOR_DELIVERY,
    });
    // A concurrent writer already moved the row → updateMany matches 0 rows.
    txOrderUpdate.mockResolvedValue({ count: 0 });
    shipping.persistTracking.mockResolvedValue(ShipmentStatus.DELIVERED);
    await service.handleShiprocket(SECRET, {
      awb: 'A1',
      current_status: 'Delivered',
    });
    expect(txPayUpdateMany).not.toHaveBeenCalled(); // no COD collection on a lost race
  });

  it('collects COD on delivery', async () => {
    prisma.shipmentDetail.findFirst.mockResolvedValue({
      id: 's1',
      status: ShipmentStatus.OUT_FOR_DELIVERY,
      orderId: 'o1',
      courierName: 'A',
    });
    prisma.order.findUnique.mockResolvedValue({
      id: 'o1',
      status: OrderStatus.OUT_FOR_DELIVERY,
    });
    shipping.persistTracking.mockResolvedValue(ShipmentStatus.DELIVERED);
    await service.handleShiprocket(SECRET, {
      awb: 'A1',
      current_status: 'Delivered',
    });
    expect(txPayUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: PaymentStatus.COD_COLLECTED }),
      }),
    );
  });
});
