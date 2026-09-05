import { StorePolicyController } from './store-policy.controller';
import { StoreConfigService } from './store-config.service';

describe('StorePolicyController (FEAT-023)', () => {
  it('exposes the storefront-visible policy fields', () => {
    const storeConfig = {
      shippingPolicy: () => ({
        freeShippingThresholdMinor: 49900,
        flatShippingFeeMinor: 4900,
        codEnabled: true,
        codChargeMinor: 500,
        minOrderMinor: 0,
      }),
    };
    const controller = new StorePolicyController(
      storeConfig as unknown as StoreConfigService,
    );
    expect(controller.policy()).toEqual({
      freeShippingThresholdMinor: 49900,
      flatShippingFeeMinor: 4900,
      codEnabled: true,
      codChargeMinor: 500,
      minOrderMinor: 0,
    });
  });

  // Nothing here may leak gateway credentials or the warehouse address.
  it('exposes nothing beyond those five fields', () => {
    const storeConfig = {
      shippingPolicy: () => ({
        freeShippingThresholdMinor: null,
        flatShippingFeeMinor: 4900,
        codEnabled: false,
        codChargeMinor: 0,
        minOrderMinor: 0,
      }),
    };
    const controller = new StorePolicyController(
      storeConfig as unknown as StoreConfigService,
    );
    expect(Object.keys(controller.policy()).sort()).toEqual([
      'codChargeMinor',
      'codEnabled',
      'flatShippingFeeMinor',
      'freeShippingThresholdMinor',
      'minOrderMinor',
    ]);
  });
});
