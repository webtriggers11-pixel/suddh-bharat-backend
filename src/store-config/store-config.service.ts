import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { decryptSecret } from '../common/secret-crypto.util';

/** Prepaid vs COD flavour for a Shiprocket booking. */
export type PaymentFlavour = 'Prepaid' | 'COD';

/** Store pickup / warehouse details (Shiprocket source address). */
export interface PickupConfig {
  location: string; // must match a Shiprocket panel pickup nickname
  name: string;
  phone: string;
  address: string;
  city: string;
  state: string;
  pincode: string;
  country: string;
}

/** Shipping / COD policy, all money in integer paise (ADR-0010). */
export interface ShippingPolicy {
  /** null = never free (always charge). */
  freeShippingThresholdMinor: number | null;
  /** Flat fallback used when a live courier rate cannot be fetched. */
  flatShippingFeeMinor: number;
  codEnabled: boolean;
  codChargeMinor: number;
  minOrderMinor: number;
}

const RAZORPAY_PROVIDER = 'razorpay';
const SHIPROCKET_PROVIDER = 'shiprocket';
const STORE_SETTINGS_ID = 'singleton';

interface DbCache {
  razorpay: { keyId: string; keySecret: string } | null;
  shiprocket: { email: string; password: string } | null;
  shiprocketWebhookSecret: string | null;
  settings: {
    codEnabled: boolean;
    codChargeMinor: number;
    freeShippingThresholdMinor: number | null;
    minOrderMinor: number;
    pickup: {
      location: string | null;
      name: string | null;
      phone: string | null;
      address: string | null;
      city: string | null;
      state: string | null;
      pincode: string | null;
      country: string | null;
    };
  } | null;
}

const EMPTY_CACHE: DbCache = {
  razorpay: null,
  shiprocket: null,
  shiprocketWebhookSecret: null,
  settings: null,
};

/**
 * Single source of truth for store / gateway configuration (payment +
 * shipping). Admin-CRUD DB tables (PaymentGateway, ShippingConfig,
 * StoreSettings) are checked first; `.env` values are the fallback for
 * whatever hasn't been configured through the admin dashboard yet, and the
 * only source for the couple of fields that have no DB column (the Razorpay
 * webhook secret, the Shiprocket base URL). Money helpers keep everything in
 * integer paise.
 */
@Injectable()
export class StoreConfigService implements OnModuleInit {
  private readonly logger = new Logger(StoreConfigService.name);
  private cache: DbCache = EMPTY_CACHE;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.refresh();
  }

  /**
   * Reload DB-backed config into the in-memory cache. Called on boot and by
   * the admin CRUD services after every write, so live payment/shipping
   * traffic picks up an admin's changes immediately instead of only on the
   * next process restart.
   */
  async refresh(): Promise<void> {
    try {
      const [gateway, shipping, settings] = await Promise.all([
        this.prisma.paymentGateway.findUnique({
          where: { provider: RAZORPAY_PROVIDER },
        }),
        this.prisma.shippingConfig.findUnique({
          where: { provider: SHIPROCKET_PROVIDER },
        }),
        this.prisma.storeSettings.findUnique({
          where: { id: STORE_SETTINGS_ID },
        }),
      ]);

      this.cache = {
        razorpay:
          gateway?.isActive === true
            ? {
                keyId: gateway.keyId,
                keySecret: decryptSecret(gateway.keySecret),
              }
            : null,
        shiprocket:
          shipping?.isActive === true
            ? {
                email: shipping.apiEmail,
                password: decryptSecret(shipping.apiPassword),
              }
            : null,
        shiprocketWebhookSecret: shipping?.webhookSecret
          ? decryptSecret(shipping.webhookSecret)
          : null,
        settings: settings
          ? {
              codEnabled: settings.codEnabled,
              codChargeMinor: settings.codChargeMinor,
              freeShippingThresholdMinor: settings.freeShippingThresholdMinor,
              minOrderMinor: settings.minOrderMinor,
              pickup: {
                location: settings.shiprocketPickupLocation,
                name: settings.pickupName,
                phone: settings.pickupPhone,
                address: settings.pickupAddress,
                city: settings.pickupCity,
                state: settings.pickupState,
                pincode: settings.pickupPincode,
                country: settings.pickupCountry,
              },
            }
          : null,
      };
    } catch (err) {
      // Keep serving the last known-good values (or the env fallback if we
      // never loaded successfully) rather than let a transient DB hiccup take
      // payments/shipping down.
      this.logger.warn(
        `Failed to refresh DB-backed store config, keeping last known values: ${String(err)}`,
      );
    }
  }

  // ---- Razorpay --------------------------------------------------------------

  /** `{ keyId, keySecret }` or `null` when Razorpay is not configured. */
  razorpay(): { keyId: string; keySecret: string } | null {
    if (this.cache.razorpay) return this.cache.razorpay;
    const keyId = this.config.get<string>('RAZORPAY_KEY_ID')?.trim();
    const keySecret = this.config.get<string>('RAZORPAY_KEY_SECRET')?.trim();
    if (!keyId || !keySecret) return null;
    return { keyId, keySecret };
  }

  /** Secret configured in the Razorpay dashboard for webhook HMAC verification.
   * PaymentGateway has no webhookSecret column yet (only ShippingConfig does),
   * so this stays env-sourced until that's added via a migration. */
  razorpayWebhookSecret(): string | null {
    return this.config.get<string>('RAZORPAY_WEBHOOK_SECRET')?.trim() || null;
  }

  // ---- Shiprocket ------------------------------------------------------------

  shiprocketBaseUrl(): string {
    return this.config
      .get<string>(
        'SHIPROCKET_BASE_URL',
        'https://apiv2.shiprocket.in/v1/external',
      )
      .trim()
      .replace(/\/+$/, '');
  }

  /** `{ email, password }` or `null` when Shiprocket is not configured. */
  shiprocketCredentials(): { email: string; password: string } | null {
    if (this.cache.shiprocket) return this.cache.shiprocket;
    const email = this.config.get<string>('SHIPROCKET_EMAIL')?.trim();
    const password = this.config.get<string>('SHIPROCKET_PASSWORD')?.trim();
    if (!email || !password) return null;
    return { email, password };
  }

  /** Shared secret used to authenticate incoming Shiprocket webhooks. */
  shiprocketWebhookSecret(): string | null {
    if (this.cache.shiprocketWebhookSecret) {
      return this.cache.shiprocketWebhookSecret;
    }
    return this.config.get<string>('SHIPROCKET_WEBHOOK_SECRET')?.trim() || null;
  }

  // ---- Pickup / warehouse ----------------------------------------------------

  /** Per-field DB-over-env merge: an admin can sync/edit pickup fields one at
   * a time (e.g. via "sync from Shiprocket"), so an unset DB field falls back
   * to env rather than blanking the whole address. */
  pickup(): PickupConfig {
    const p = this.cache.settings?.pickup;
    return {
      location:
        p?.location?.trim() ||
        this.config.get<string>('SHIPROCKET_PICKUP_LOCATION', 'Primary').trim(),
      name:
        p?.name?.trim() ||
        this.config.get<string>('STORE_PICKUP_NAME', 'Shuddha Bharat').trim(),
      phone:
        p?.phone?.trim() ||
        this.config.get<string>('STORE_PICKUP_PHONE', '').trim(),
      address:
        p?.address?.trim() ||
        this.config.get<string>('STORE_PICKUP_ADDRESS', '').trim(),
      city:
        p?.city?.trim() ||
        this.config.get<string>('STORE_PICKUP_CITY', '').trim(),
      state:
        p?.state?.trim() ||
        this.config.get<string>('STORE_PICKUP_STATE', '').trim(),
      pincode:
        p?.pincode?.trim() ||
        this.config.get<string>('STORE_PICKUP_PINCODE', '').trim(),
      country:
        p?.country?.trim() ||
        this.config.get<string>('STORE_PICKUP_COUNTRY', 'India').trim(),
    };
  }

  // ---- Shipping / COD policy -------------------------------------------------

  /** Once the StoreSettings row exists, it's the source of truth for every
   * field it has a column for; `flatShippingFeeMinor` has no DB column, so it
   * always comes from env. */
  shippingPolicy(): ShippingPolicy {
    const s = this.cache.settings;
    return {
      freeShippingThresholdMinor: s
        ? s.freeShippingThresholdMinor
        : this.intOrNull('STORE_FREE_SHIPPING_THRESHOLD_MINOR', 49900),
      flatShippingFeeMinor: this.int('STORE_SHIPPING_FEE_MINOR', 4900),
      codEnabled: s ? s.codEnabled : this.bool('STORE_COD_ENABLED', true),
      codChargeMinor: s
        ? s.codChargeMinor
        : this.int('STORE_COD_CHARGE_MINOR', 0),
      minOrderMinor: s ? s.minOrderMinor : this.int('STORE_MIN_ORDER_MINOR', 0),
    };
  }

  // ---- parsing helpers -------------------------------------------------------

  private int(key: string, fallback: number): number {
    const raw = this.config.get<string>(key);
    if (raw === undefined || raw === null || `${raw}`.trim() === '')
      return fallback;
    const n = Number(raw);
    return Number.isFinite(n) ? Math.trunc(n) : fallback;
  }

  /** Like `int`, but an explicitly empty value means "no threshold" (null). */
  private intOrNull(key: string, fallback: number | null): number | null {
    const raw = this.config.get<string>(key);
    if (raw === undefined) return fallback;
    const trimmed = `${raw}`.trim();
    if (trimmed === '') return null;
    const n = Number(trimmed);
    return Number.isFinite(n) ? Math.trunc(n) : fallback;
  }

  private bool(key: string, fallback: boolean): boolean {
    const raw = this.config.get<string>(key);
    if (raw === undefined || raw === null || `${raw}`.trim() === '')
      return fallback;
    return ['1', 'true', 'yes', 'y', 'on'].includes(
      `${raw}`.trim().toLowerCase(),
    );
  }
}
