import { ConfigService } from '@nestjs/config';
import { StoreConfigService } from './store-config.service';
import { PrismaService } from '../prisma/prisma.service';
import { encryptSecret } from '../common/secret-crypto.util';

process.env.CONFIG_ENCRYPTION_KEY = 'test-key';

function makeConfig(env: Record<string, string> = {}): ConfigService {
  return {
    get: (key: string, fallback?: unknown) => env[key] ?? fallback,
  } as unknown as ConfigService;
}

describe('StoreConfigService', () => {
  let prisma: {
    paymentGateway: { findUnique: jest.Mock };
    shippingConfig: { findUnique: jest.Mock };
    storeSettings: { findUnique: jest.Mock };
  };

  beforeEach(() => {
    prisma = {
      paymentGateway: { findUnique: jest.fn().mockResolvedValue(null) },
      shippingConfig: { findUnique: jest.fn().mockResolvedValue(null) },
      storeSettings: { findUnique: jest.fn().mockResolvedValue(null) },
    };
  });

  function make(env: Record<string, string> = {}) {
    return new StoreConfigService(
      makeConfig(env),
      prisma as unknown as PrismaService,
    );
  }

  it('falls back to env when no DB rows exist', async () => {
    const service = make({
      RAZORPAY_KEY_ID: 'env_key',
      RAZORPAY_KEY_SECRET: 'env_secret',
    });
    await service.refresh();
    expect(service.razorpay()).toEqual({
      keyId: 'env_key',
      keySecret: 'env_secret',
    });
  });

  it('prefers an active DB-configured Razorpay gateway over env', async () => {
    prisma.paymentGateway.findUnique.mockResolvedValue({
      keyId: 'db_key',
      keySecret: encryptSecret('db_secret'),
      isActive: true,
    });
    const service = make({
      RAZORPAY_KEY_ID: 'env_key',
      RAZORPAY_KEY_SECRET: 'env_secret',
    });
    await service.refresh();
    expect(service.razorpay()).toEqual({
      keyId: 'db_key',
      keySecret: 'db_secret',
    });
  });

  it('ignores a deactivated DB gateway and falls back to env', async () => {
    prisma.paymentGateway.findUnique.mockResolvedValue({
      keyId: 'db_key',
      keySecret: 'db_secret',
      isActive: false,
    });
    const service = make({
      RAZORPAY_KEY_ID: 'env_key',
      RAZORPAY_KEY_SECRET: 'env_secret',
    });
    await service.refresh();
    expect(service.razorpay()).toEqual({
      keyId: 'env_key',
      keySecret: 'env_secret',
    });
  });

  it('picks up a DB-configured Shiprocket webhook secret', async () => {
    prisma.shippingConfig.findUnique.mockResolvedValue({
      apiEmail: 'a@b.com',
      apiPassword: encryptSecret('p'),
      isActive: true,
      webhookSecret: encryptSecret('db_secret'),
    });
    const service = make();
    await service.refresh();
    expect(service.shiprocketCredentials()).toEqual({
      email: 'a@b.com',
      password: 'p',
    });
    expect(service.shiprocketWebhookSecret()).toBe('db_secret');
  });

  it('merges pickup fields per-field, falling back to env for unset ones', async () => {
    prisma.storeSettings.findUnique.mockResolvedValue({
      codEnabled: true,
      codChargeMinor: 0,
      freeShippingThresholdMinor: null,
      minOrderMinor: 0,
      shiprocketPickupLocation: 'Warehouse A',
      pickupName: null,
      pickupPhone: null,
      pickupAddress: null,
      pickupCity: null,
      pickupState: null,
      pickupPincode: null,
      pickupCountry: null,
    });
    const service = make({ STORE_PICKUP_NAME: 'Env Store Name' });
    await service.refresh();
    const pickup = service.pickup();
    expect(pickup.location).toBe('Warehouse A'); // from DB
    expect(pickup.name).toBe('Env Store Name'); // fell back to env
  });

  it('uses the DB StoreSettings row for shipping policy once it exists', async () => {
    prisma.storeSettings.findUnique.mockResolvedValue({
      codEnabled: false,
      codChargeMinor: 5000,
      freeShippingThresholdMinor: null,
      minOrderMinor: 1000,
      shiprocketPickupLocation: null,
      pickupName: null,
      pickupPhone: null,
      pickupAddress: null,
      pickupCity: null,
      pickupState: null,
      pickupPincode: null,
      pickupCountry: null,
    });
    const service = make({ STORE_COD_ENABLED: 'true' });
    await service.refresh();
    const policy = service.shippingPolicy();
    expect(policy.codEnabled).toBe(false); // DB overrides env
    expect(policy.codChargeMinor).toBe(5000);
    expect(policy.minOrderMinor).toBe(1000);
  });
});
