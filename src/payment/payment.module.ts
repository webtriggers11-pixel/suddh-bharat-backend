import { Module } from '@nestjs/common';
import { CouponsModule } from '../coupons/coupons.module';
import { PaymentController } from './payment.controller';
import { PaymentService } from './payment.service';
import { RazorpayClient } from './razorpay.client';

/** Razorpay payment module (ADR-0011). StoreConfigService is global. */
@Module({
  imports: [CouponsModule],
  controllers: [PaymentController],
  providers: [PaymentService, RazorpayClient],
  exports: [PaymentService, RazorpayClient],
})
export class PaymentModule {}
