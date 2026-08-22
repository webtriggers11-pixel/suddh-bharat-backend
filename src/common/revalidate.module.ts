import { Global, Module } from '@nestjs/common';
import { RevalidateService } from './revalidate.service';

/** Global so any service can bust storefront cache tags after a write. */
@Global()
@Module({
  providers: [RevalidateService],
  exports: [RevalidateService],
})
export class RevalidateModule {}
