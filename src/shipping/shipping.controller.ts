import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { Role } from '@prisma/client';
import { Public } from '../auth/decorators/public.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/decorators/current-user.decorator';
import { ShippingService } from './shipping.service';
import {
  EstimateQueryDto,
  RateQueryDto,
  SchedulePickupDto,
} from './dto/shipping.dto';

/** Shipping rates + Shiprocket booking/tracking (ADR-0011). */
@Controller('shipping')
export class ShippingController {
  constructor(private readonly shipping: ShippingService) {}

  /** Live rate for the authenticated user's cart. */
  @Get('rates')
  rates(@CurrentUser() user: AuthUser, @Query() q: RateQueryDto) {
    return this.shipping.getRatesForCart(user.id, q.pincode);
  }

  /** Public single-product delivery estimate. */
  @Public()
  @Get('estimate')
  estimate(@Query() q: EstimateQueryDto) {
    return this.shipping.getEstimateForProduct(q.productId, q.pincode);
  }

  /** Book a Shiprocket shipment (create order + assign AWB). */
  @Roles(Role.ADMIN, Role.SUPERADMIN)
  @Post('create/:orderId')
  create(@Param('orderId') orderId: string) {
    return this.shipping.createShipment(orderId);
  }

  /** Sync tracking from the courier and return the shipment (owner-scoped). */
  @Get('track/:orderId')
  track(@CurrentUser() user: AuthUser, @Param('orderId') orderId: string) {
    const scope = isAdmin(user) ? undefined : user.id;
    return this.shipping.syncTracking(orderId, scope);
  }

  /** Stored shipment details, no live call (owner-scoped). */
  @Get('details/:orderId')
  details(@CurrentUser() user: AuthUser, @Param('orderId') orderId: string) {
    const scope = isAdmin(user) ? undefined : user.id;
    return this.shipping.getShipment(orderId, scope);
  }

  /** Schedule a pickup for a booked shipment. */
  @Roles(Role.ADMIN, Role.SUPERADMIN)
  @Post('pickup/:orderId')
  pickup(@Param('orderId') orderId: string, @Body() dto: SchedulePickupDto) {
    return this.shipping.schedulePickup(orderId, dto.pickupDate);
  }
}

function isAdmin(user: AuthUser): boolean {
  return (
    user.roles.includes(Role.ADMIN) || user.roles.includes(Role.SUPERADMIN)
  );
}
