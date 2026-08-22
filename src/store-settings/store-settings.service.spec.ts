import { StoreSettingsService } from './store-settings.service';
import { PrismaService } from '../prisma/prisma.service';

describe('StoreSettingsService', () => {
  let prisma: {
    storeSettings: { upsert: jest.Mock; update: jest.Mock };
  };
  let service: StoreSettingsService;

  beforeEach(() => {
    prisma = {
      storeSettings: {
        upsert: jest.fn().mockResolvedValue({ id: 'singleton' }),
        update: jest.fn().mockResolvedValue({ id: 'singleton' }),
      },
    };
    service = new StoreSettingsService(prisma as unknown as PrismaService);
  });

  it('seeds the singleton row on first read', async () => {
    await service.get();
    expect(prisma.storeSettings.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'singleton' } }),
    );
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
});
