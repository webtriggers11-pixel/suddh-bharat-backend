import { ConflictException, NotFoundException } from '@nestjs/common';
import { ShippingConfigsService } from './shipping-configs.service';
import { PrismaService } from '../prisma/prisma.service';
import { StoreConfigService } from '../store-config/store-config.service';
import { StoreSettingsService } from '../store-settings/store-settings.service';

const row = {
  id: 's1',
  provider: 'shiprocket',
  displayName: 'Shiprocket',
  apiEmail: 'a@b.com',
  apiPassword: 'secret',
  token: null,
  tokenExpiresAt: null,
  webhookSecret: null,
  isActive: true,
  isTestMode: false,
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe('ShippingConfigsService', () => {
  let prisma: {
    shippingConfig: {
      findMany: jest.Mock;
      findUnique: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
      delete: jest.Mock;
    };
  };
  let storeConfig: { shiprocketBaseUrl: jest.Mock };
  let storeSettings: { syncPickup: jest.Mock };
  let service: ShippingConfigsService;

  beforeEach(() => {
    prisma = {
      shippingConfig: {
        findMany: jest.fn().mockResolvedValue([row]),
        findUnique: jest.fn(),
        create: jest.fn().mockResolvedValue(row),
        update: jest.fn().mockResolvedValue(row),
        delete: jest.fn().mockResolvedValue(row),
      },
    };
    storeConfig = {
      shiprocketBaseUrl: jest.fn().mockReturnValue('https://sr.test'),
    };
    storeSettings = { syncPickup: jest.fn() };
    service = new ShippingConfigsService(
      prisma as unknown as PrismaService,
      storeConfig as unknown as StoreConfigService,
      storeSettings as unknown as StoreSettingsService,
    );
  });

  it('never leaks the password or webhook secret', async () => {
    const rows = await service.list();
    expect(rows[0]).not.toHaveProperty('apiPassword');
    expect(rows[0]).not.toHaveProperty('webhookSecret');
    expect(rows[0].hasToken).toBe(false);
  });

  it('rejects a duplicate provider (409)', async () => {
    prisma.shippingConfig.findUnique.mockResolvedValue(row);
    await expect(
      service.create({
        provider: 'Shiprocket',
        displayName: 'x',
        apiEmail: 'a@b.com',
        apiPassword: 'p',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('keeps existing password when update omits it', async () => {
    prisma.shippingConfig.findUnique.mockResolvedValue(row);
    await service.update('s1', { displayName: 'New' });
    const dataArg = prisma.shippingConfig.update.mock.calls[0][0].data;
    expect(dataArg).not.toHaveProperty('apiPassword');
  });

  it('returns a failure message when test login fails (no throw)', async () => {
    prisma.shippingConfig.findUnique.mockResolvedValue(row);
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => '{}',
    }) as any;
    const result = await service.testConnection('s1');
    expect(result.success).toBe(false);
  });

  it('generates and stores a webhook secret on register', async () => {
    prisma.shippingConfig.findUnique.mockResolvedValue(row);
    const result = await service.registerWebhook('s1', {
      webhookUrl: 'https://x/y',
    });
    expect(result.success).toBe(true);
    const dataArg = prisma.shippingConfig.update.mock.calls[0][0].data;
    expect(typeof dataArg.webhookSecret).toBe('string');
  });

  it('throws NotFound for a missing config', async () => {
    prisma.shippingConfig.findUnique.mockResolvedValue(null);
    await expect(service.remove('nope')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
