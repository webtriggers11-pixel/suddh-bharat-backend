import { BadRequestException, NotFoundException } from '@nestjs/common';
import { OrderStatus, PaymentMethod } from '@prisma/client';
import { OrdersService } from './orders.service';
import { PrismaService } from '../prisma/prisma.service';

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
    },
    ...over,
  };
}

describe('OrdersService', () => {
  let prisma: {
    cartItem: { findMany: jest.Mock };
    address: { findFirst: jest.Mock };
    order: { findMany: jest.Mock; findFirst: jest.Mock };
    $transaction: jest.Mock;
  };
  let tx: {
    product: { updateMany: jest.Mock };
    order: { create: jest.Mock; update: jest.Mock };
    address: { update: jest.Mock };
    cartItem: { deleteMany: jest.Mock };
    $queryRaw: jest.Mock;
  };
  let service: OrdersService;

  beforeEach(() => {
    tx = {
      product: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      order: {
        create: jest.fn().mockImplementation(({ data }) => ({
          id: 'o1',
          ...data,
        })),
        update: jest.fn(),
      },
      address: { update: jest.fn() },
      cartItem: { deleteMany: jest.fn() },
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
    service = new OrdersService(prisma as unknown as PrismaService);
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

  it('places a COD order: atomic stock decrement, totals + flat shipping, cart cleared, address locked', async () => {
    const order = await service.checkout('u1', 'e@x.com', dto);
    // atomic conditional decrement guarded by stock >= qty
    const decArg = tx.product.updateMany.mock.calls[0][0];
    expect(decArg.where.stock).toEqual({ gte: 2 });
    expect(decArg.data.stock).toEqual({ decrement: 2 });
    // totals: 34900*2 = 69800 subtotal; under ₹499? no (69800 ≥ 49900) → free shipping
    expect(order.subtotalMinor).toBe(69800);
    expect(order.shippingMinor).toBe(0);
    expect(order.totalMinor).toBe(69800);
    expect(order.status).toBe(OrderStatus.PLACED);
    expect(order.orderNumber).toMatch(/^SB-\d{8}-001000$/);
    expect(tx.cartItem.deleteMany).toHaveBeenCalledWith({
      where: { userId: 'u1' },
    });
    expect(tx.address.update).toHaveBeenCalledWith({
      where: { id: 'a1' },
      data: { isLocked: true },
    });
  });

  it('charges flat shipping under the free-shipping threshold', async () => {
    prisma.cartItem.findMany.mockResolvedValue([
      cartLine({
        quantity: 1,
        product: { ...cartLine().product, priceMinor: 14900 },
      }),
    ]);
    const order = await service.checkout('u1', 'e@x.com', dto);
    expect(order.subtotalMinor).toBe(14900);
    expect(order.shippingMinor).toBe(4900);
    expect(order.totalMinor).toBe(19800);
  });

  it('rejects when stock is insufficient (atomic decrement matched 0 rows)', async () => {
    tx.product.updateMany.mockResolvedValue({ count: 0 });
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
});
