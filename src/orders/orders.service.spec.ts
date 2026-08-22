import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { OrderStatus, PaymentMethod, PaymentStatus } from '@prisma/client';
import { OrdersService } from './orders.service';
import { PrismaService } from '../prisma/prisma.service';
import { ShippingService } from '../shipping/shipping.service';
import { StoreConfigService } from '../store-config/store-config.service';
import { CouponsService } from '../coupons/coupons.service';
import { reserveStock, releaseStock } from '../common/stock';

jest.mock('../common/stock');
const reserveStockMock = reserveStock as jest.Mock;
const releaseStockMock = releaseStock as jest.Mock;

function cartLine(over: Record<string, unknown> = {}) {
  return {
    productId: 'p1',
    quantity: 2,
    product: {
      id: 'p1',
      name: 'Atta',
      slug: 'atta',
      images: ['img1'],
      priceMinor: 34900,
      stock: 10,
      isActive: true,
      deletedAt: null,
      weightKg: 1,
      lengthCm: 10,
      breadthCm: 10,
      heightCm: 5,
    },
    ...over,
  };
}

const DEFAULT_POLICY = {
  freeShippingThresholdMinor: 49900,
  flatShippingFeeMinor: 4900,
  codEnabled: true,
  codChargeMinor: 0,
  minOrderMinor: 0,
};

describe('OrdersService', () => {
  let prisma: {
    cartItem: { findMany: jest.Mock };
    address: { findFirst: jest.Mock };
    order: { findMany: jest.Mock; findFirst: jest.Mock };
    $transaction: jest.Mock;
  };
  let tx: {
    product: { updateMany: jest.Mock };
    order: {
      create: jest.Mock;
      update: jest.Mock;
      updateMany: jest.Mock;
      findUniqueOrThrow: jest.Mock;
    };
    address: { update: jest.Mock };
    cartItem: { deleteMany: jest.Mock };
    paymentTransaction: { updateMany: jest.Mock; findMany: jest.Mock };
    $queryRaw: jest.Mock;
  };
  let shipping: { buildPackage: jest.Mock; getLiveRate: jest.Mock };
  let store: { shippingPolicy: jest.Mock };
  let coupons: { validate: jest.Mock; consume: jest.Mock };
  let service: OrdersService;

  beforeEach(() => {
    reserveStockMock.mockReset().mockResolvedValue(true);
    releaseStockMock.mockReset().mockResolvedValue(undefined);
    tx = {
      product: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      order: {
        create: jest.fn().mockImplementation(({ data }) => ({
          id: 'o1',
          ...data,
        })),
        update: jest.fn(),
        // CAS transition wins by default (1 row matched).
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: jest.fn().mockResolvedValue({
          id: 'o1',
          status: OrderStatus.CANCELLED,
        }),
      },
      address: { update: jest.fn() },
      cartItem: { deleteMany: jest.fn() },
      paymentTransaction: {
        updateMany: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]), // no captured payment by default
      },
      $queryRaw: jest.fn().mockResolvedValue([{ nextval: 1000n }]),
    };
    prisma = {
      cartItem: { findMany: jest.fn().mockResolvedValue([cartLine()]) },
      address: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'a1',
          userId: 'u1',
          fullName: 'User',
          phone: '9876543210',
          line1: '1 Road',
          line2: null,
          city: 'Pune',
          state: 'MH',
          pincode: '411001',
          deletedAt: null,
        }),
      },
      order: { findMany: jest.fn(), findFirst: jest.fn() },
      $transaction: jest.fn((cb: (t: typeof tx) => unknown) => cb(tx)),
    };
    shipping = {
      buildPackage: jest.fn().mockReturnValue({
        weightKg: 1,
        lengthCm: 10,
        breadthCm: 10,
        heightCm: 5,
      }),
      // Default: live rate unavailable → checkout must fall back to the flat fee.
      getLiveRate: jest.fn().mockRejectedValue(new Error('not configured')),
    };
    store = {
      shippingPolicy: jest.fn().mockReturnValue({ ...DEFAULT_POLICY }),
    };
    coupons = {
      validate: jest.fn(),
      consume: jest.fn().mockResolvedValue(true),
    };
    service = new OrdersService(
      prisma as unknown as PrismaService,
      shipping as unknown as ShippingService,
      store as unknown as StoreConfigService,
      coupons as unknown as CouponsService,
    );
  });

  const dto = { addressId: 'a1', paymentMethod: PaymentMethod.COD };

  it('rejects checkout with an empty cart (400)', async () => {
    prisma.cartItem.findMany.mockResolvedValue([]);
    await expect(service.checkout('u1', 'e@x.com', dto)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('404s when the address is missing/not owned', async () => {
    prisma.address.findFirst.mockResolvedValue(null);
    await expect(service.checkout('u1', 'e@x.com', dto)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('places a COD order: free shipping over threshold, cart cleared, address locked', async () => {
    const order = await service.checkout('u1', 'e@x.com', dto);
    // COD reserves all lines in one atomic bulk statement.
    expect(reserveStockMock).toHaveBeenCalledWith(tx, [
      { productId: 'p1', quantity: 2 },
    ]);
    // 34900*2 = 69800 ≥ 49900 → free shipping, no live-rate call.
    expect(order.subtotalMinor).toBe(69800);
    expect(order.shippingMinor).toBe(0);
    expect(order.isFreeShipping).toBe(true);
    expect(order.totalMinor).toBe(69800);
    expect(order.status).toBe(OrderStatus.PLACED);
    expect(order.orderNumber).toMatch(/^SB-\d{8}-001000$/);
    expect(shipping.getLiveRate).not.toHaveBeenCalled();
    expect(tx.cartItem.deleteMany).toHaveBeenCalledWith({
      where: { userId: 'u1' },
    });
    expect(tx.address.update).toHaveBeenCalledWith({
      where: { id: 'a1' },
      data: { isLocked: true },
    });
  });

  it('uses the live courier rate under the free-shipping threshold', async () => {
    prisma.cartItem.findMany.mockResolvedValue([
      cartLine({
        quantity: 1,
        product: { ...cartLine().product, priceMinor: 14900 },
      }),
    ]);
    shipping.getLiveRate.mockResolvedValue({
      courierId: '1',
      courierName: 'Delhivery',
      rateMinor: 6500,
      estimatedDays: 4,
      estimatedDelivery: new Date().toISOString(),
    });
    const order = await service.checkout('u1', 'e@x.com', dto);
    expect(order.subtotalMinor).toBe(14900);
    expect(order.shippingMinor).toBe(6500);
    expect(order.shippingCourier).toBe('Delhivery');
    expect(order.totalMinor).toBe(21400);
  });

  it('falls back to the flat fee when the live rate fails', async () => {
    prisma.cartItem.findMany.mockResolvedValue([
      cartLine({
        quantity: 1,
        product: { ...cartLine().product, priceMinor: 14900 },
      }),
    ]);
    const order = await service.checkout('u1', 'e@x.com', dto);
    expect(order.shippingMinor).toBe(4900);
    expect(order.shippingCourier).toBe('Standard');
    expect(order.totalMinor).toBe(19800);
  });

  it('adds the COD charge and keeps COD order PLACED + COD_PENDING', async () => {
    store.shippingPolicy.mockReturnValue({
      ...DEFAULT_POLICY,
      codChargeMinor: 3000,
    });
    const order = await service.checkout('u1', 'e@x.com', dto);
    expect(order.codChargeMinor).toBe(3000);
    expect(order.totalMinor).toBe(72800); // 69800 + 0 shipping + 3000 cod
    const createArg = tx.order.create.mock.calls[0][0];
    expect(createArg.data.payments.create.status).toBe(
      PaymentStatus.COD_PENDING,
    );
  });

  it('starts an online order PENDING and DEFERS stock/cart/address (no reservation)', async () => {
    const order = await service.checkout('u1', 'e@x.com', {
      addressId: 'a1',
      paymentMethod: PaymentMethod.RAZORPAY,
    });
    expect(order.status).toBe(OrderStatus.PENDING);
    expect(order.placedAt).toBeNull();
    const createArg = tx.order.create.mock.calls[0][0];
    expect(createArg.data.payments.create.status).toBe(PaymentStatus.INITIATED);
    // Online must NOT reserve stock, clear the cart, or lock the address at
    // checkout — those happen only on payment success (so an abandoned payment
    // never loses the cart or holds stock).
    expect(tx.product.updateMany).not.toHaveBeenCalled();
    expect(tx.cartItem.deleteMany).not.toHaveBeenCalled();
    expect(tx.address.update).not.toHaveBeenCalled();
  });

  it('applies a validated coupon: discount off the total + usage consumed', async () => {
    coupons.validate.mockResolvedValue({
      couponId: 'c1',
      code: 'SAVE50',
      discountType: 'FIXED',
      discountValue: 5000,
      discountAmountMinor: 5000,
      finalTotalMinor: 64800,
    });
    const order = await service.checkout('u1', 'e@x.com', {
      ...dto,
      couponCode: 'save50',
    });
    expect(coupons.validate).toHaveBeenCalledWith('save50', 69800);
    expect(order.discountMinor).toBe(5000);
    expect(order.couponCode).toBe('SAVE50');
    expect(order.totalMinor).toBe(64800); // 69800 - 5000 (free shipping)
    expect(coupons.consume).toHaveBeenCalled();
  });

  it('rejects checkout when the coupon just hit its usage limit (consume fails)', async () => {
    coupons.validate.mockResolvedValue({
      couponId: 'c1',
      code: 'SAVE50',
      discountType: 'FIXED',
      discountValue: 5000,
      discountAmountMinor: 5000,
      finalTotalMinor: 64800,
    });
    coupons.consume.mockResolvedValue(false);
    await expect(
      service.checkout('u1', 'e@x.com', { ...dto, couponCode: 'save50' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects an online checkout when a cart item is out of stock', async () => {
    prisma.cartItem.findMany.mockResolvedValue([
      cartLine({ product: { ...cartLine().product, stock: 0 } }),
    ]);
    await expect(
      service.checkout('u1', 'e@x.com', {
        addressId: 'a1',
        paymentMethod: PaymentMethod.RAZORPAY,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects COD when the store has it disabled', async () => {
    store.shippingPolicy.mockReturnValue({
      ...DEFAULT_POLICY,
      codEnabled: false,
    });
    await expect(service.checkout('u1', 'e@x.com', dto)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('enforces the minimum order value', async () => {
    store.shippingPolicy.mockReturnValue({
      ...DEFAULT_POLICY,
      minOrderMinor: 100000,
    });
    await expect(service.checkout('u1', 'e@x.com', dto)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('rejects when stock is insufficient (bulk reserve did not cover every line)', async () => {
    reserveStockMock.mockResolvedValue(false);
    await expect(service.checkout('u1', 'e@x.com', dto)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('blocks cancel from a non-cancellable state', async () => {
    prisma.order.findFirst.mockResolvedValue({
      id: 'o1',
      userId: 'u1',
      status: OrderStatus.SHIPPED,
      items: [],
      deletedAt: null,
    });
    await expect(service.cancel('u1', 'o1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('cancels an unpaid online PENDING order WITHOUT restocking (never reserved)', async () => {
    prisma.order.findFirst.mockResolvedValue({
      id: 'o1',
      orderNumber: 'SB-1',
      userId: 'u1',
      status: OrderStatus.PENDING,
      paymentMethod: PaymentMethod.RAZORPAY,
      items: [{ productId: 'p1', quantity: 2 }],
      payments: [],
      deletedAt: null,
    });
    await service.cancel('u1', 'o1');
    // CAS transition fired, no captured payment → no phantom restock.
    expect(tx.order.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'o1',
          status: OrderStatus.PENDING,
        }),
        data: expect.objectContaining({ status: OrderStatus.CANCELLED }),
      }),
    );
    expect(releaseStockMock).not.toHaveBeenCalled();
  });

  it('restocks when cancelling a COD order (stock was reserved)', async () => {
    prisma.order.findFirst.mockResolvedValue({
      id: 'o1',
      orderNumber: 'SB-1',
      userId: 'u1',
      status: OrderStatus.PLACED,
      paymentMethod: PaymentMethod.COD,
      items: [{ productId: 'p1', quantity: 2 }],
      payments: [],
      deletedAt: null,
    });
    await service.cancel('u1', 'o1');
    // Restock happens via the bulk releaseStock util (was a per-item loop).
    expect(releaseStockMock).toHaveBeenCalledWith(tx, [
      { productId: 'p1', quantity: 2 },
    ]);
  });

  it('aborts the cancel (409) when a concurrent verify already moved the order', async () => {
    prisma.order.findFirst.mockResolvedValue({
      id: 'o1',
      orderNumber: 'SB-1',
      userId: 'u1',
      status: OrderStatus.PENDING,
      paymentMethod: PaymentMethod.RAZORPAY,
      items: [{ productId: 'p1', quantity: 2 }],
      payments: [],
      deletedAt: null,
    });
    tx.order.updateMany.mockResolvedValue({ count: 0 }); // CAS lost the race
    await expect(service.cancel('u1', 'o1')).rejects.toBeInstanceOf(
      ConflictException,
    );
    // Never touched stock or payments after losing the CAS.
    expect(releaseStockMock).not.toHaveBeenCalled();
    expect(tx.paymentTransaction.updateMany).not.toHaveBeenCalled();
  });

  it('admin cancel of a captured order flags needsReview + refund and restocks', async () => {
    prisma.order.findFirst.mockResolvedValue(null);
    // adminGet path → findFirst on order returns the paid order.
    prisma.order.findFirst.mockResolvedValue({
      id: 'o1',
      orderNumber: 'SB-1',
      userId: 'u1',
      status: OrderStatus.PLACED,
      paymentMethod: PaymentMethod.RAZORPAY,
      items: [{ productId: 'p1', quantity: 2 }],
      payments: [{ id: 't1', status: PaymentStatus.SUCCESS }],
      shipment: null,
      deletedAt: null,
    });
    // The captured payment is visible on the fresh in-tx read too.
    tx.paymentTransaction.findMany.mockResolvedValue([
      { status: PaymentStatus.SUCCESS },
    ]);
    await service.updateStatus('o1', { status: OrderStatus.CANCELLED });
    // Stock was reserved on capture → released on cancel.
    expect(releaseStockMock).toHaveBeenCalledWith(tx, [
      { productId: 'p1', quantity: 2 },
    ]);
    // Refund owed → needsReview flag set.
    expect(tx.order.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ needsReview: true }),
      }),
    );
  });
});
