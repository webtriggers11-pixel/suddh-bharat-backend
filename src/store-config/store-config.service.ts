import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

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

/**
 * Single source of truth for env-driven store / gateway configuration
 * (payment + shipping). Values live in `.env` for now (admin-CRUD config tables
 * are a later FEAT). Money helpers keep everything in integer paise.
 */
@Injectable()
export class StoreConfigService {
  constructor(private readonly config: ConfigService) {}

  // ---- Razorpay --------------------------------------------------------------

  /** `{ keyId, keySecret }` or `null` when Razorpay is not configured. */
  razorpay(): { keyId: string; keySecret: string } | null {
    const keyId = this.config.get<string>('RAZORPAY_KEY_ID')?.trim();
    const keySecret = this.config.get<string>('RAZORPAY_KEY_SECRET')?.trim();
    if (!keyId || !keySecret) return null;
    return { keyId, keySecret };
  }

  /** Secret configured in the Razorpay dashboard for webhook HMAC verification. */
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
    const email = this.config.get<string>('SHIPROCKET_EMAIL')?.trim();
    const password = this.config.get<string>('SHIPROCKET_PASSWORD')?.trim();
    if (!email || !password) return null;
    return { email, password };
  }

  /** Shared secret used to authenticate incoming Shiprocket webhooks. */
  shiprocketWebhookSecret(): string | null {
    return this.config.get<string>('SHIPROCKET_WEBHOOK_SECRET')?.trim() || null;
  }

  // ---- Pickup / warehouse ----------------------------------------------------

  pickup(): PickupConfig {
    return {
      location: this.config
        .get<string>('SHIPROCKET_PICKUP_LOCATION', 'Primary')
        .trim(),
      name: this.config
        .get<string>('STORE_PICKUP_NAME', 'Shuddha Bharat')
        .trim(),
      phone: this.config.get<string>('STORE_PICKUP_PHONE', '').trim(),
      address: this.config.get<string>('STORE_PICKUP_ADDRESS', '').trim(),
      city: this.config.get<string>('STORE_PICKUP_CITY', '').trim(),
      state: this.config.get<string>('STORE_PICKUP_STATE', '').trim(),
      pincode: this.config.get<string>('STORE_PICKUP_PINCODE', '').trim(),
      country: this.config.get<string>('STORE_PICKUP_COUNTRY', 'India').trim(),
    };
  }

  // ---- Shipping / COD policy -------------------------------------------------

  shippingPolicy(): ShippingPolicy {
    return {
      freeShippingThresholdMinor: this.intOrNull(
        'STORE_FREE_SHIPPING_THRESHOLD_MINOR',
        49900,
      ),
      flatShippingFeeMinor: this.int('STORE_SHIPPING_FEE_MINOR', 4900),
      codEnabled: this.bool('STORE_COD_ENABLED', true),
      codChargeMinor: this.int('STORE_COD_CHARGE_MINOR', 0),
      minOrderMinor: this.int('STORE_MIN_ORDER_MINOR', 0),
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
