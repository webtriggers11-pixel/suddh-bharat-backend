import { Global, Module } from '@nestjs/common';
import { StoreConfigService } from './store-config.service';

/**
 * Global so payment / shipping / orders can all read env-driven store config
 * without re-importing. ConfigModule is already global (app.module).
 */
@Global()
@Module({
  providers: [StoreConfigService],
  exports: [StoreConfigService],
})
export class StoreConfigModule {}
