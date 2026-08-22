import { Module } from '@nestjs/common';
import { ShippingModule } from '../shipping/shipping.module';
import { PaymentModule } from '../payment/payment.module';
import { WebhooksController } from './webhooks.controller';
import { WebhooksService } from './webhooks.service';

/**
 * Provider webhooks: Shiprocket (tracking) + Razorpay (payment capture
 * fallback). Reuses ShippingService/ShiprocketClient and PaymentService/
 * RazorpayClient from their modules.
 */
@Module({
  imports: [ShippingModule, PaymentModule],
  controllers: [WebhooksController],
  providers: [WebhooksService],
})
export class WebhooksModule {}
