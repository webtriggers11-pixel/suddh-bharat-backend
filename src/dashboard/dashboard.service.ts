import { Injectable } from '@nestjs/common';
import { OrderStatus, PaymentStatus, Prisma, Role } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/** Resolved-payment statuses that count toward collected revenue. */
const PAID_STATUSES: PaymentStatus[] = [
  PaymentStatus.SUCCESS,
  PaymentStatus.COD_COLLECTED,
];

/** Order statuses considered "pending" for the dashboard stat footer. */
const PENDING_STATUSES: OrderStatus[] = [
  OrderStatus.PENDING,
  OrderStatus.PLACED,
];

const LOW_STOCK_THRESHOLD = 5;

export interface DashboardStats {
  totalRevenueMinor: number;
  totalOrders: number;
  pendingOrders: number;
  totalCustomers: number;
  activeProducts: number;
  lowStockCount: number;
}

export interface RevenuePoint {
  date: string; // YYYY-MM-DD
  revenueMinor: number;
  orders: number;
}

export interface RecentOrder {
  id: string;
  orderNumber: string;
  createdAt: Date;
  status: OrderStatus;
  paymentStatus: PaymentStatus | null;
  totalMinor: number;
}

type RangeKey = '7d' | '30d' | '90d';
const RANGE_DAYS: Record<RangeKey, number> = { '7d': 7, '30d': 30, '90d': 90 };

/** Read-only aggregates powering the admin dashboard overview (spec 02). */
@Injectable()
export class DashboardService {
  constructor(private readonly prisma: PrismaService) {}

  async stats(): Promise<DashboardStats> {
    const [revenue, totalOrders, pendingOrders, totalCustomers, products] =
      await Promise.all([
        this.prisma.paymentTransaction.aggregate({
          _sum: { amountMinor: true },
          where: { status: { in: PAID_STATUSES } },
        }),
        this.prisma.order.count({ where: { deletedAt: null } }),
        this.prisma.order.count({
          where: { deletedAt: null, status: { in: PENDING_STATUSES } },
        }),
        this.prisma.user.count({ where: { roles: { has: Role.USER } } }),
        this.prisma.product.findMany({
          where: { deletedAt: null, isActive: true },
          select: { stock: true },
        }),
      ]);

    return {
      totalRevenueMinor: revenue._sum.amountMinor ?? 0,
      totalOrders,
      pendingOrders,
      totalCustomers,
      activeProducts: products.length,
      lowStockCount: products.filter((p) => p.stock < LOW_STOCK_THRESHOLD)
        .length,
    };
  }

  async revenue(range: RangeKey = '90d'): Promise<RevenuePoint[]> {
    const days = RANGE_DAYS[range] ?? 90;
    const since = new Date();
    since.setUTCHours(0, 0, 0, 0);
    since.setUTCDate(since.getUTCDate() - (days - 1));

    const rows = await this.prisma.$queryRaw<
      { date: string; revenueMinor: bigint; orders: bigint }[]
    >(Prisma.sql`
      SELECT to_char(date_trunc('day', o."createdAt"), 'YYYY-MM-DD') AS date,
             COALESCE(SUM(
               CASE WHEN EXISTS (
                 SELECT 1 FROM "PaymentTransaction" p
                 WHERE p."orderId" = o.id
                   AND p.status IN ('SUCCESS', 'COD_COLLECTED')
               ) THEN o."totalMinor" ELSE 0 END
             ), 0)::bigint AS "revenueMinor",
             COUNT(*)::bigint AS orders
      FROM "Order" o
      WHERE o."createdAt" >= ${since} AND o."deletedAt" IS NULL
      GROUP BY 1
      ORDER BY 1
    `);

    // Fill missing days with zeros so the chart has a continuous series.
    const byDate = new Map(
      rows.map((r) => [
        r.date,
        { revenueMinor: Number(r.revenueMinor), orders: Number(r.orders) },
      ]),
    );
    const series: RevenuePoint[] = [];
    for (let i = 0; i < days; i++) {
      const d = new Date(since);
      d.setUTCDate(since.getUTCDate() + i);
      const key = d.toISOString().slice(0, 10);
      const hit = byDate.get(key);
      series.push({
        date: key,
        revenueMinor: hit?.revenueMinor ?? 0,
        orders: hit?.orders ?? 0,
      });
    }
    return series;
  }

  async recentOrders(limit = 8): Promise<RecentOrder[]> {
    const take = Math.min(Math.max(limit, 1), 50);
    const orders = await this.prisma.order.findMany({
      where: { deletedAt: null },
      orderBy: { createdAt: 'desc' },
      take,
      include: { payments: { orderBy: { createdAt: 'desc' }, take: 1 } },
    });
    return orders.map((o) => ({
      id: o.id,
      orderNumber: o.orderNumber,
      createdAt: o.createdAt,
      status: o.status,
      paymentStatus: o.payments[0]?.status ?? null,
      totalMinor: o.totalMinor,
    }));
  }
}
