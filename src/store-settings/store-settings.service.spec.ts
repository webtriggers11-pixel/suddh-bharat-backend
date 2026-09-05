import { StoreSettingsService } from './store-settings.service';
import { PrismaService } from '../prisma/prisma.service';
import { StoreConfigService } from '../store-config/store-config.service';

describe('StoreSettingsService', () => {
  let prisma: {
    storeSettings: { upsert: jest.Mock; update: jest.Mock };
  };
  let storeConfig: { shippingPolicy: jest.Mock; refresh: jest.Mock };
  let revalidate: { revalidate: jest.Mock };
  let service: StoreSettingsService;

  beforeEach(() => {
    prisma = {
      storeSettings: {
        upsert: jest.fn().mockResolvedValue({ id: 'singleton' }),
        update: jest.fn().mockResolvedValue({ id: 'singleton' }),
      },
    };
    storeConfig = {
      shippingPolicy: jest.fn().mockReturnValue({
        freeShippingThresholdMinor: 49900,
        flatShippingFeeMinor: 4900,
        codEnabled: true,
        codChargeMinor: 0,
        minOrderMinor: 0,
      }),
      refresh: jest.fn().mockResolvedValue(undefined),
    };
    revalidate = { revalidate: jest.fn() };
    service = new StoreSettingsService(
      prisma as unknown as PrismaService,
      storeConfig as unknown as StoreConfigService,
      revalidate as unknown as import('../common/revalidate.service').RevalidateService,
    );
  });

  it('seeds the singleton row on first read', async () => {
    await service.get();
    expect(prisma.storeSettings.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'singleton' } }),
    );
  });

  it('seeds the row from the current env-configured policy, not bare defaults', async () => {
    await service.get();
    const createArg = prisma.storeSettings.upsert.mock.calls[0][0].create;
    expect(createArg.freeShippingThresholdMinor).toBe(49900);
    expect(createArg.codEnabled).toBe(true);
  });

  it('refreshes the live config cache after get/update', async () => {
    await service.get();
    await service.update({ codEnabled: false });
    // get() runs once inside update() too, so refresh is called on each get + each update.
    expect(storeConfig.refresh).toHaveBeenCalled();
  });

  it('clears the free-shipping threshold when null is passed', async () => {
    await service.update({ freeShippingThresholdMinor: null });
    const dataArg = prisma.storeSettings.update.mock.calls[0][0].data;
    expect(dataArg.freeShippingThresholdMinor).toBeNull();
  });

  it('leaves the threshold untouched when omitted', async () => {
    await service.update({ codEnabled: false });
    const dataArg = prisma.storeSettings.update.mock.calls[0][0].data;
    expect(dataArg).not.toHaveProperty('freeShippingThresholdMinor');
    expect(dataArg.codEnabled).toBe(false);
  });

  // FEAT-023 — the storefront reads /store/policy through the Next Data Cache;
  // without this bust it keeps advertising the old free-shipping threshold.
  it('busts the storefront policy cache after an update', async () => {
    await service.update({ freeShippingThresholdMinor: 99900 });
    expect(revalidate.revalidate).toHaveBeenCalledWith(['store-policy']);
  });
});
