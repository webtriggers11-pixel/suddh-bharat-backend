import { Module } from '@nestjs/common';
import { ShippingModule } from '../shipping/shipping.module';
import { CouponsModule } from '../coupons/coupons.module';
import { OrdersController } from './orders.controller';
import { OrdersAdminController } from './orders.admin.controller';
import { OrdersService } from './orders.service';

/** Orders + checkout. Imports ShippingModule (rates) + CouponsModule (discounts). */
@Module({
  imports: [ShippingModule, CouponsModule],
  controllers: [OrdersController, OrdersAdminController],
  providers: [OrdersService],
  exports: [OrdersService],
})
export class OrdersModule {}
