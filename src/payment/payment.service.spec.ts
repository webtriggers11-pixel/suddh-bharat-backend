import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { OrderStatus, PaymentMethod, PaymentStatus } from '@prisma/client';
import { PaymentService } from './payment.service';
import { PrismaService } from '../prisma/prisma.service';
import { RazorpayClient } from './razorpay.client';
import { reserveStock } from '../common/stock';

jest.mock('../common/stock');
const reserveStockMock = reserveStock as jest.Mock;

function baseOrder(over: Record<string, unknown> = {}) {
  return {
    id: 'o1',
    orderNumber: 'SB-1',
    userId: 'u1',
    addressId: 'a1',
    status: OrderStatus.PENDING,
    totalMinor: 50000,
    paymentMethod: PaymentMethod.RAZORPAY,
    items: [{ productId: 'p1', quantity: 2 }],
    payments: [],
    ...over,
  };
}

describe('PaymentService', () => {
  let prisma: {
    order: {
      findFirst: jest.Mock;
      updateMany: jest.Mock;
      findUniqueOrThrow: jest.Mock;
    };
    paymentTransaction: { create: jest.Mock; update: jest.Mock };
    $transaction: jest.Mock;
  };
  let razorpay: {
    createOrder: jest.Mock;
    publicKeyId: jest.Mock;
    verifySignature: jest.Mock;
  };
  let service: PaymentService;
  let txProductUpdateMany: jest.Mock;
  let txAddressUpdateMany: jest.Mock;
  let txCartDeleteMany: jest.Mock;
  let txOrderUpdate: jest.Mock;

  beforeEach(() => {
    reserveStockMock.mockReset().mockResolvedValue(true);
    txProductUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
    txAddressUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
    txCartDeleteMany = jest.fn().mockResolvedValue({ count: 1 });
    txOrderUpdate = jest.fn().mockResolvedValue({});
    prisma = {
      order: {
        findFirst: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: jest.fn().mockResolvedValue(baseOrder()),
      },
      paymentTransaction: {
        create: jest.fn().mockResolvedValue({ id: 'txn1' }),
        update: jest.fn().mockResolvedValue({ id: 'txn1' }),
      },
      $transaction: jest.fn(async (cb) =>
        cb({
          paymentTransaction: { update: jest.fn(), updateMany: jest.fn() },
          order: {
            updateMany: prisma.order.updateMany,
            findUnique: jest
              .fn()
              .mockResolvedValue({ status: OrderStatus.PLACED }),
            update: txOrderUpdate,
          },
          product: { updateMany: txProductUpdateMany },
          address: { updateMany: txAddressUpdateMany },
          cartItem: { deleteMany: txCartDeleteMany },
        }),
      ),
    };
    razorpay = {
      createOrder: jest.fn().mockResolvedValue({ id: 'order_x' }),
      publicKeyId: jest.fn().mockReturnValue('rzp_test'),
      verifySignature: jest.fn(),
    };
    service = new PaymentService(
      prisma as unknown as PrismaService,
      razorpay as unknown as RazorpayClient,
      {
        revalidate: jest.fn(),
      } as unknown as import('../common/revalidate.service').RevalidateService,
      {
        consume: jest.fn().mockResolvedValue(true),
        release: jest.fn().mockResolvedValue(undefined),
      } as unknown as import('../coupons/coupons.service').CouponsService,
    );
  });

  describe('initiate', () => {
    it('404s for a missing order', async () => {
      prisma.order.findFirst.mockResolvedValue(null);
      await expect(
        service.initiate('u1', { orderId: 'o1' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('rejects COD orders', async () => {
      prisma.order.findFirst.mockResolvedValue(
        baseOrder({ paymentMethod: PaymentMethod.COD }),
      );
      await expect(
        service.initiate('u1', { orderId: 'o1' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('409s when the order is already paid (not PENDING)', async () => {
      prisma.order.findFirst.mockResolvedValue(
        baseOrder({ status: OrderStatus.PLACED }),
      );
      await expect(
        service.initiate('u1', { orderId: 'o1' }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('creates a gateway order and a PENDING txn with paise amount', async () => {
      prisma.order.findFirst.mockResolvedValue(baseOrder());
      const res = await service.initiate('u1', { orderId: 'o1' });
      expect(razorpay.createOrder).toHaveBeenCalledWith(50000, 'SB-1');
      expect(res.amountPaise).toBe(50000);
      expect(res.keyId).toBe('rzp_test');
      expect(prisma.paymentTransaction.create).toHaveBeenCalled();
    });

    it('reuses an in-flight transaction on retry (no new attempt row)', async () => {
      prisma.order.findFirst.mockResolvedValue(
        baseOrder({
          payments: [
            { id: 'txnA', status: PaymentStatus.INITIATED, attempt: 1 },
          ],
        }),
      );
      await service.initiate('u1', { orderId: 'o1' });
      expect(prisma.paymentTransaction.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'txnA' } }),
      );
      expect(prisma.paymentTransaction.create).not.toHaveBeenCalled();
    });
  });

  describe('verify', () => {
    const dto = {
      orderId: 'o1',
      razorpayOrderId: 'order_x',
      razorpayPaymentId: 'pay_1',
      razorpaySignature: 'sig',
    };

    it('is idempotent when a SUCCESS txn already exists', async () => {
      prisma.order.findFirst.mockResolvedValue(
        baseOrder({
          status: OrderStatus.PLACED,
          payments: [
            {
              id: 't',
              gatewayOrderId: 'order_x',
              status: PaymentStatus.SUCCESS,
            },
          ],
        }),
      );
      await service.verify('u1', dto);
      expect(razorpay.verifySignature).not.toHaveBeenCalled();
      expect(prisma.order.findUniqueOrThrow).toHaveBeenCalled();
    });

    it('400s when no txn matches the gateway order', async () => {
      prisma.order.findFirst.mockResolvedValue(baseOrder({ payments: [] }));
      await expect(service.verify('u1', dto)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('marks the txn FAILED and throws on a bad signature', async () => {
      const update = jest.fn();
      prisma.paymentTransaction.update = update;
      prisma.order.findFirst.mockResolvedValue(
        baseOrder({
          payments: [
            {
              id: 't1',
              gatewayOrderId: 'order_x',
              status: PaymentStatus.PENDING,
            },
          ],
        }),
      );
      razorpay.verifySignature.mockReturnValue(false);
      await expect(service.verify('u1', dto)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: PaymentStatus.FAILED }),
        }),
      );
    });

    it('advances PENDING → PLACED and commits deferred side effects', async () => {
      prisma.order.findFirst.mockResolvedValue(
        baseOrder({
          payments: [
            {
              id: 't1',
              gatewayOrderId: 'order_x',
              status: PaymentStatus.PENDING,
            },
          ],
        }),
      );
      razorpay.verifySignature.mockReturnValue(true);
      await service.verify('u1', dto);
      expect(prisma.order.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'o1', status: OrderStatus.PENDING },
          data: expect.objectContaining({ status: OrderStatus.PLACED }),
        }),
      );
      // Stock reserved (bulk), address locked, cart cleared — only now, on success.
      expect(reserveStockMock).toHaveBeenCalledWith(expect.anything(), [
        { productId: 'p1', quantity: 2 },
      ]);
      expect(txAddressUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'a1' } }),
      );
      expect(txCartDeleteMany).toHaveBeenCalledWith({
        where: { userId: 'u1' },
      });
    });

    it('skips side effects when a concurrent verify already moved the order', async () => {
      prisma.order.updateMany.mockResolvedValue({ count: 0 }); // lost the race
      prisma.order.findFirst.mockResolvedValue(
        baseOrder({
          payments: [
            {
              id: 't1',
              gatewayOrderId: 'order_x',
              status: PaymentStatus.PENDING,
            },
          ],
        }),
      );
      razorpay.verifySignature.mockReturnValue(true);
      await service.verify('u1', dto);
      expect(txProductUpdateMany).not.toHaveBeenCalled();
      expect(txCartDeleteMany).not.toHaveBeenCalled();
    });

    it('flags needsReview when payment lands on a CANCELLED order (refund owed)', async () => {
      prisma.order.updateMany.mockResolvedValue({ count: 0 }); // CAS lost
      prisma.order.findFirst.mockResolvedValue(
        baseOrder({
          payments: [
            {
              id: 't1',
              gatewayOrderId: 'order_x',
              status: PaymentStatus.PENDING,
            },
          ],
        }),
      );
      // The tx sees the order is now CANCELLED, not PLACED.
      prisma.$transaction.mockImplementationOnce(
        async (cb: (t: unknown) => unknown) =>
          cb({
            paymentTransaction: { update: jest.fn(), updateMany: jest.fn() },
            order: {
              updateMany: prisma.order.updateMany,
              findUnique: jest
                .fn()
                .mockResolvedValue({ status: OrderStatus.CANCELLED }),
              update: txOrderUpdate,
            },
            product: { updateMany: txProductUpdateMany },
            address: { updateMany: txAddressUpdateMany },
            cartItem: { deleteMany: txCartDeleteMany },
          }),
      );
      razorpay.verifySignature.mockReturnValue(true);
      await service.verify('u1', dto);
      expect(txOrderUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ needsReview: true }),
        }),
      );
      expect(txProductUpdateMany).not.toHaveBeenCalled();
    });
  });
});
