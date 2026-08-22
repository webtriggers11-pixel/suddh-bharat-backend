import { Module } from '@nestjs/common';
import { StoreSettingsModule } from '../store-settings/store-settings.module';
import { ShippingConfigsController } from './shipping-configs.controller';
import { ShippingConfigsService } from './shipping-configs.service';

@Module({
  imports: [StoreSettingsModule],
  controllers: [ShippingConfigsController],
  providers: [ShippingConfigsService],
})
export class ShippingConfigsModule {}
