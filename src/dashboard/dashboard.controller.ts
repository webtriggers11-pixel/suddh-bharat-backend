import { Controller, Get, Query } from '@nestjs/common';
import { Role } from '@prisma/client';
import { Roles } from '../auth/decorators/roles.decorator';
import { DashboardService } from './dashboard.service';

type RangeKey = '7d' | '30d' | '90d';

/** Admin dashboard overview aggregates (spec 02). ADMIN/SUPERADMIN only. */
@Roles(Role.ADMIN, Role.SUPERADMIN)
@Controller('admin/dashboard')
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get('stats')
  stats() {
    return this.dashboard.stats();
  }

  @Get('revenue')
  revenue(@Query('range') range?: string) {
    const valid: RangeKey[] = ['7d', '30d', '90d'];
    const key = valid.includes(range as RangeKey) ? (range as RangeKey) : '90d';
    return this.dashboard.revenue(key);
  }

  @Get('recent-orders')
  recentOrders(@Query('limit') limit?: string) {
    const n = Number(limit);
    return this.dashboard.recentOrders(Number.isFinite(n) ? n : 8);
  }
}
