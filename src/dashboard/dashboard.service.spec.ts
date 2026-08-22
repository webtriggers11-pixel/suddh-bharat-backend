import { OrderStatus, PaymentStatus } from '@prisma/client';
import { DashboardService } from './dashboard.service';
import { PrismaService } from '../prisma/prisma.service';

describe('DashboardService', () => {
  let prisma: {
    paymentTransaction: { aggregate: jest.Mock };
    order: { count: jest.Mock; findMany: jest.Mock };
    user: { count: jest.Mock };
    product: { findMany: jest.Mock };
    $queryRaw: jest.Mock;
  };
  let service: DashboardService;

  beforeEach(() => {
    prisma = {
      paymentTransaction: {
        aggregate: jest
          .fn()
          .mockResolvedValue({ _sum: { amountMinor: 12345 } }),
      },
      order: { count: jest.fn(), findMany: jest.fn() },
      user: { count: jest.fn().mockResolvedValue(7) },
      product: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ stock: 2 }, { stock: 10 }, { stock: 0 }]),
      },
      $queryRaw: jest.fn().mockResolvedValue([]),
    };
    service = new DashboardService(prisma as unknown as PrismaService);
  });

  it('aggregates stats and counts low stock (< 5)', async () => {
    prisma.order.count
      .mockResolvedValueOnce(20) // totalOrders
      .mockResolvedValueOnce(4); // pendingOrders

    const stats = await service.stats();

    expect(stats).toEqual({
      totalRevenueMinor: 12345,
      totalOrders: 20,
      pendingOrders: 4,
      totalCustomers: 7,
      activeProducts: 3,
      lowStockCount: 2, // stock 2 and 0 are < 5
    });
  });

  it('fills missing days with zero revenue points', async () => {
    const series = await service.revenue('7d');
    expect(series).toHaveLength(7);
    expect(series.every((p) => p.revenueMinor === 0 && p.orders === 0)).toBe(
      true,
    );
    // Ascending, unique dates.
    const dates = series.map((p) => p.date);
    expect([...dates].sort()).toEqual(dates);
  });

  it('derives payment status from the latest transaction for recent orders', async () => {
    prisma.order.findMany.mockResolvedValue([
      {
        id: 'o1',
        orderNumber: 'SB-1',
        createdAt: new Date('2026-01-01'),
        status: OrderStatus.PLACED,
        totalMinor: 500,
        payments: [{ status: PaymentStatus.SUCCESS }],
      },
      {
        id: 'o2',
        orderNumber: 'SB-2',
        createdAt: new Date('2026-01-02'),
        status: OrderStatus.PENDING,
        totalMinor: 900,
        payments: [],
      },
    ]);

    const recent = await service.recentOrders(8);
    expect(recent[0].paymentStatus).toBe(PaymentStatus.SUCCESS);
    expect(recent[1].paymentStatus).toBeNull();
    expect(recent[0].totalMinor).toBe(500);
  });
});
