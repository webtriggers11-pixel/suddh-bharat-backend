import { Controller, Get } from '@nestjs/common';
import { Public } from '../auth/decorators/public.decorator';
import { StoreConfigService } from './store-config.service';

/** The storefront-visible slice of the shipping/COD policy (FEAT-023). */
export interface PublicStorePolicy {
  /** null = shipping is never free. Integer paise. */
  freeShippingThresholdMinor: number | null;
  flatShippingFeeMinor: number;
  codEnabled: boolean;
  codChargeMinor: number;
  minOrderMinor: number;
}

/**
 * Public read of the shipping/COD policy an admin edits in Store Settings.
 * The storefront hardcoded its own copy of the free-shipping threshold and
 * flat fee, so it could advertise terms the server did not honour. Exposes
 * only the numbers a shopper is shown anyway — no credentials, no pickup
 * address.
 */
@Controller('store')
export class StorePolicyController {
  constructor(private readonly storeConfig: StoreConfigService) {}

  @Public()
  @Get('policy')
  policy(): PublicStorePolicy {
    const p = this.storeConfig.shippingPolicy();
    return {
      freeShippingThresholdMinor: p.freeShippingThresholdMinor,
      flatShippingFeeMinor: p.flatShippingFeeMinor,
      codEnabled: p.codEnabled,
      codChargeMinor: p.codChargeMinor,
      minOrderMinor: p.minOrderMinor,
    };
  }
}
