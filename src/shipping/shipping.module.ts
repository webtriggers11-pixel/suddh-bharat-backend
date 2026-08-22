import { Module } from '@nestjs/common';
import { ShippingController } from './shipping.controller';
import { ShippingService } from './shipping.service';
import { ShiprocketClient } from './shiprocket.client';

/**
 * Shipping (Shiprocket). Exports ShippingService (used by Orders at checkout for
 * server-authoritative rates) and ShiprocketClient (used by Webhooks to register
 * the webhook URL). StoreConfigService is global.
 */
@Module({
  controllers: [ShippingController],
  providers: [ShippingService, ShiprocketClient],
  exports: [ShippingService, ShiprocketClient],
})
export class ShippingModule {}
