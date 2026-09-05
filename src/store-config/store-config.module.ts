import { Global, Module } from '@nestjs/common';
import { StoreConfigService } from './store-config.service';
import { StorePolicyController } from './store-policy.controller';

/**
 * Global so payment / shipping / orders can all read env-driven store config
 * without re-importing. ConfigModule is already global (app.module).
 */
@Global()
@Module({
  controllers: [StorePolicyController],
  providers: [StoreConfigService],
  exports: [StoreConfigService],
})
export class StoreConfigModule {}
