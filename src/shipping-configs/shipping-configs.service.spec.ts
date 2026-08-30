import { ConflictException, NotFoundException } from '@nestjs/common';
import { ShippingConfigsService } from './shipping-configs.service';
import { PrismaService } from '../prisma/prisma.service';
import { StoreConfigService } from '../store-config/store-config.service';
import { StoreSettingsService } from '../store-settings/store-settings.service';
import { decryptSecret, encryptSecret } from '../common/secret-crypto.util';

process.env.CONFIG_ENCRYPTION_KEY = 'test-key';

const row = {
  id: 's1',
  provider: 'shiprocket',
  displayName: 'Shiprocket',
  apiEmail: 'a@b.com',
  apiPassword: encryptSecret('secret'),
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
  let storeConfig: { shiprocketBaseUrl: jest.Mock; refresh: jest.Mock };
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
      refresh: jest.fn().mockResolvedValue(undefined),
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

  it('encrypts the password at rest on create and update', async () => {
    prisma.shippingConfig.findUnique.mockResolvedValue(null);
    await service.create({
      provider: 'shiprocket',
      displayName: 'x',
      apiEmail: 'a@b.com',
      apiPassword: 'plain-pass',
    });
    const createArg = prisma.shippingConfig.create.mock.calls[0][0].data as {
      apiPassword: string;
    };
    expect(createArg.apiPassword).not.toBe('plain-pass');
    expect(decryptSecret(createArg.apiPassword)).toBe('plain-pass');

    prisma.shippingConfig.findUnique.mockResolvedValue(row);
    await service.update('s1', { apiPassword: 'rotated-pass' });
    const updateArg = prisma.shippingConfig.update.mock.calls[0][0].data as {
      apiPassword: string;
    };
    expect(decryptSecret(updateArg.apiPassword)).toBe('rotated-pass');
  });

  it('reuses a cached non-expired token instead of re-authenticating', async () => {
    const cached = {
      ...row,
      token: 'cached-token',
      tokenExpiresAt: new Date(Date.now() + 3600_000),
    };
    prisma.shippingConfig.findUnique.mockResolvedValue(cached);
    global.fetch = jest.fn();
    const result = await service.testConnection('s1');
    expect(result.success).toBe(true);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(prisma.shippingConfig.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { token: 'cached-token', tokenExpiresAt: cached.tokenExpiresAt },
      }),
    );
  });

  it('re-authenticates when the cached token has expired', async () => {
    const expired = {
      ...row,
      token: 'stale-token',
      tokenExpiresAt: new Date(Date.now() - 1000),
    };
    prisma.shippingConfig.findUnique.mockResolvedValue(expired);
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ token: 'fresh-token' }),
    }) as any;
    await service.testConnection('s1');
    expect(global.fetch).toHaveBeenCalled();
  });

  it('refreshes the live config cache after create/update/remove/registerWebhook', async () => {
    prisma.shippingConfig.findUnique.mockResolvedValue(null);
    await service.create({
      provider: 'shiprocket',
      displayName: 'x',
      apiEmail: 'a@b.com',
      apiPassword: 'p',
    });
    prisma.shippingConfig.findUnique.mockResolvedValue(row);
    await service.update('s1', { displayName: 'New' });
    await service.registerWebhook('s1', { webhookUrl: 'https://x/y' });
    await service.remove('s1');
    expect(storeConfig.refresh).toHaveBeenCalledTimes(4);
  });

  it('decrypts the stored password before calling the provider login', async () => {
    prisma.shippingConfig.findUnique.mockResolvedValue(row);
    let sentBody: unknown;
    global.fetch = jest.fn().mockImplementation((_url, init) => {
      sentBody = JSON.parse(init.body as string);
      return Promise.resolve({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ token: 't' }),
      });
    }) as any;
    await service.testConnection('s1');
    expect(sentBody).toMatchObject({ email: 'a@b.com', password: 'secret' });
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
