/* eslint-disable @typescript-eslint/unbound-method --
 * These tests read decorator metadata off the prototype, which means
 * deliberately referencing handlers as values. Nothing is ever called, so the
 * `this`-scoping hazard the rule guards against cannot occur.
 */
import { Reflector } from '@nestjs/core';
import { StorePolicyController } from './store-policy.controller';
import { StoreConfigService } from './store-config.service';
import { IS_PUBLIC_KEY } from '../auth/decorators/public.decorator';
import { ROLES_KEY } from '../auth/decorators/roles.decorator';

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

  // The storefront reads this unauthenticated; JwtAuthGuard is global, so
  // losing @Public() would silently 401 every page that shows shipping terms.
  it('is public and carries no role requirement', () => {
    const reflector = new Reflector();
    const handler = StorePolicyController.prototype.policy;
    expect(reflector.get(IS_PUBLIC_KEY, handler)).toBe(true);
    expect(reflector.get(ROLES_KEY, handler)).toBeUndefined();
  });
});
