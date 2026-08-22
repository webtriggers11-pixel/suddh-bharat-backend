import {
  Injectable,
  Inject,
  Optional,
  Logger,
  ServiceUnavailableException,
  BadGatewayException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { Redis } from 'ioredis';
import { StoreConfigService } from '../store-config/store-config.service';
import { REDIS_CLIENT } from '../common/redis.module';

/** A single serviceable courier option returned by Shiprocket. */
export interface CourierOption {
  courierId: string;
  courierName: string;
  /** Total freight charge in rupees (Shiprocket returns rupees). */
  rate: number;
  /** Parsed estimated delivery days (best-effort). */
  estimatedDays: number;
}

export interface ServiceabilityRequest {
  pickupPincode: string;
  deliveryPincode: string;
  weightKg: number;
  cod: boolean;
  lengthCm?: number;
  breadthCm?: number;
  heightCm?: number;
}

export interface AdhocOrderRequest {
  orderId: string; // our order number
  orderDate: string; // "YYYY-MM-DD HH:mm"
  pickupLocation: string;
  billingName: string;
  billingAddress: string;
  billingCity: string;
  billingState: string;
  billingPincode: string;
  billingPhone: string;
  billingEmail?: string;
  paymentMethod: 'Prepaid' | 'COD';
  subTotal: number; // rupees
  lengthCm: number;
  breadthCm: number;
  heightCm: number;
  weightKg: number;
  items: {
    name: string;
    sku: string;
    units: number;
    sellingPrice: number; // rupees
  }[];
}

interface TokenCache {
  token: string;
  expiresAt: number; // epoch ms
}

const REFRESH_MARGIN_MS = 60 * 60 * 1000; // refresh when < 1h remains
const TOKEN_TTL_MS = 9 * 24 * 60 * 60 * 1000; // cache ~9 days
const TOKEN_REDIS_KEY = 'shiprocket:auth:token';

/**
 * Thin Shiprocket REST client (no SDK). Manages the bearer token in-memory with
 * a 9-day cache refreshed when under an hour remains. Every method maps provider
 * failures onto precise HTTP errors so callers never leak a raw fetch error.
 */
@Injectable()
export class ShiprocketClient {
  private readonly logger = new Logger(ShiprocketClient.name);
  /** L1: in-process cache — fastest, per-instance. */
  private tokenCache: TokenCache | null = null;
  /** De-dupes concurrent logins so a burst of calls triggers one auth round-trip. */
  private loginInFlight: Promise<string> | null = null;

  constructor(
    private readonly store: StoreConfigService,
    // L2: shared Redis cache — one login serves every instance and survives a
    // restart (T10). Optional/null when REDIS_URL is unset → L1-only, as before.
    @Optional()
    @Inject(REDIS_CLIENT)
    private readonly redis: Redis | null = null,
  ) {}

  private baseUrl(): string {
    return this.store.shiprocketBaseUrl();
  }

  /** Force a fresh login on the next call (e.g. after a 401). */
  invalidateToken(): void {
    this.tokenCache = null;
    // Fire-and-forget: drop the shared copy too so no instance reuses it.
    if (this.redis) {
      this.redis.del(TOKEN_REDIS_KEY).catch(() => undefined);
    }
  }

  private async getToken(forceRefresh = false): Promise<string> {
    if (!forceRefresh) {
      const cached = await this.readValidToken();
      if (cached) return cached;
    }
    if (this.loginInFlight) return this.loginInFlight;

    this.loginInFlight = this.login().finally(() => {
      this.loginInFlight = null;
    });
    return this.loginInFlight;
  }

  /** A still-valid token from L1 (memory) or L2 (Redis), else null. */
  private async readValidToken(): Promise<string | null> {
    const now = Date.now();
    if (
      this.tokenCache &&
      this.tokenCache.expiresAt - now > REFRESH_MARGIN_MS
    ) {
      return this.tokenCache.token;
    }
    if (this.redis) {
      try {
        const raw = await this.redis.get(TOKEN_REDIS_KEY);
        if (raw) {
          const parsed = JSON.parse(raw) as TokenCache;
          if (parsed.expiresAt - now > REFRESH_MARGIN_MS) {
            this.tokenCache = parsed; // warm L1 from the shared copy
            return parsed.token;
          }
        }
      } catch (err) {
        this.logger.warn(
          `Shiprocket token Redis read failed, will re-login: ${String(err)}`,
        );
      }
    }
    return null;
  }

  /** Persist a freshly-minted token to the shared Redis cache (best-effort). */
  private async persistToken(cache: TokenCache): Promise<void> {
    if (!this.redis) return;
    const ttlSec = Math.floor((cache.expiresAt - Date.now()) / 1000);
    if (ttlSec <= 0) return;
    try {
      await this.redis.set(
        TOKEN_REDIS_KEY,
        JSON.stringify(cache),
        'EX',
        ttlSec,
      );
    } catch (err) {
      this.logger.warn(`Shiprocket token Redis write failed: ${String(err)}`);
    }
  }

  private async login(): Promise<string> {
    const creds = this.store.shiprocketCredentials();
    if (!creds) {
      throw new ServiceUnavailableException(
        'Shipping provider is not configured',
      );
    }
    const data = await this.request<{ token?: string }>(
      'POST',
      '/auth/login',
      { email: creds.email, password: creds.password },
      undefined,
      /* isLogin */ true,
    );
    if (!data.token) {
      throw new BadGatewayException('Shipping provider did not return a token');
    }
    this.tokenCache = {
      token: data.token,
      expiresAt: Date.now() + TOKEN_TTL_MS,
    };
    await this.persistToken(this.tokenCache);
    return data.token;
  }

  /**
   * Core fetch wrapper. On a 401 (expired token) it retries once with a fresh
   * login. `isLogin` avoids infinite recursion on the auth endpoint itself.
   */
  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    token?: string,
    isLogin = false,
    retriedAuth = false,
  ): Promise<T> {
    const url = `${this.baseUrl()}${path}`;
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        // Bound outbound latency so a slow courier API can't wedge workers.
        signal: AbortSignal.timeout(12_000),
      });
    } catch (err) {
      this.logger.error(
        `Shiprocket ${method} ${path} network error: ${String(err)}`,
      );
      throw new BadGatewayException('Could not reach the shipping provider');
    }

    if (res.status === 401 && !isLogin && !retriedAuth) {
      this.invalidateToken();
      const fresh = await this.getToken(true);
      return this.request<T>(method, path, body, fresh, false, true);
    }

    const text = await res.text();
    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }

    if (!res.ok) {
      const message = this.extractMessage(parsed) ?? `HTTP ${res.status}`;
      this.logger.warn(
        `Shiprocket ${method} ${path} failed: ${res.status} ${message}`,
      );
      throw new BadGatewayException(`Shipping provider error: ${message}`);
    }
    return parsed as T;
  }

  private extractMessage(parsed: unknown): string | null {
    if (parsed && typeof parsed === 'object') {
      const obj = parsed as Record<string, unknown>;
      if (typeof obj.message === 'string') return obj.message;
      if (typeof obj.error === 'string') return obj.error;
    }
    return typeof parsed === 'string' ? parsed : null;
  }

  private async authed<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const token = await this.getToken();
    return this.request<T>(method, path, body, token);
  }

  // ---- Public API ------------------------------------------------------------

  /** Cheapest-first list of serviceable couriers for a package. */
  async serviceability(req: ServiceabilityRequest): Promise<CourierOption[]> {
    const params = new URLSearchParams({
      pickup_postcode: req.pickupPincode,
      delivery_postcode: req.deliveryPincode,
      weight: String(req.weightKg),
      cod: req.cod ? '1' : '0',
    });
    if (req.lengthCm) params.set('length', String(req.lengthCm));
    if (req.breadthCm) params.set('breadth', String(req.breadthCm));
    if (req.heightCm) params.set('height', String(req.heightCm));

    const data = await this.authed<{
      data?: { available_courier_companies?: RawCourier[] };
    }>('GET', `/courier/serviceability/?${params.toString()}`);

    const couriers = data?.data?.available_courier_companies ?? [];
    if (couriers.length === 0) {
      throw new UnprocessableEntityException(
        'No courier services this delivery location',
      );
    }
    return couriers
      .map((c) => ({
        courierId: String(c.courier_company_id ?? ''),
        courierName: String(c.courier_name ?? 'Courier'),
        rate: Number(c.rate ?? c.freight_charge ?? 0),
        estimatedDays: parseEta(c.estimated_delivery_days ?? c.etd ?? null),
      }))
      .filter((c) => c.rate > 0)
      .sort((a, b) => a.rate - b.rate);
  }

  /** Create an adhoc order → `{ shiprocketOrderId, shiprocketShipmentId }`. */
  async createAdhocOrder(
    req: AdhocOrderRequest,
  ): Promise<{ shiprocketOrderId: string; shiprocketShipmentId: string }> {
    const payload = {
      order_id: req.orderId,
      order_date: req.orderDate,
      pickup_location: req.pickupLocation,
      billing_customer_name: req.billingName,
      billing_last_name: '',
      billing_address: req.billingAddress,
      billing_city: req.billingCity,
      billing_pincode: req.billingPincode,
      billing_state: req.billingState,
      billing_country: 'India',
      billing_email: req.billingEmail ?? '',
      billing_phone: req.billingPhone,
      shipping_is_billing: true,
      order_items: req.items.map((it) => ({
        name: it.name,
        sku: it.sku,
        units: it.units,
        selling_price: it.sellingPrice,
      })),
      payment_method: req.paymentMethod,
      sub_total: req.subTotal,
      length: req.lengthCm,
      breadth: req.breadthCm,
      height: req.heightCm,
      weight: req.weightKg,
    };
    const data = await this.authed<{
      order_id?: number | string;
      shipment_id?: number | string;
    }>('POST', '/orders/create/adhoc', payload);
    if (!data.order_id || !data.shipment_id) {
      throw new BadGatewayException(
        'Shipping provider did not return shipment ids',
      );
    }
    return {
      shiprocketOrderId: String(data.order_id),
      shiprocketShipmentId: String(data.shipment_id),
    };
  }

  /** Assign an AWB to a shipment → `{ awbCode, courierName, courierId }`. */
  async assignAwb(
    shiprocketShipmentId: string,
  ): Promise<{ awbCode: string; courierName: string; courierId: string }> {
    const data = await this.authed<{
      response?: { data?: RawAwb };
      awb_assign_status?: number;
    }>('POST', '/courier/assign/awb', {
      shipment_id: Number(shiprocketShipmentId),
    });

    const awb = data?.response?.data;
    if (!awb?.awb_code) {
      const message = this.extractMessage(data) ?? 'AWB assignment failed';
      throw new BadGatewayException(`Shipping provider error: ${message}`);
    }
    return {
      awbCode: String(awb.awb_code),
      courierName: String(awb.courier_name ?? 'Courier'),
      courierId: String(awb.courier_company_id ?? ''),
    };
  }

  /** Schedule a pickup for a shipment. */
  async generatePickup(
    shiprocketShipmentId: string,
    pickupDate?: string,
  ): Promise<void> {
    await this.authed('POST', '/courier/generate/pickup', {
      shipment_id: [Number(shiprocketShipmentId)],
      expected_package_count: 1,
      ...(pickupDate ? { pickup_date: [pickupDate] } : {}),
    });
  }

  /** Pull raw tracking activities for an AWB. */
  async trackAwb(awb: string): Promise<RawTrackActivity[]> {
    const data = await this.authed<{
      tracking_data?: { shipment_track_activities?: RawTrackActivity[] };
    }>('GET', `/courier/track/awb/${encodeURIComponent(awb)}`);
    return data?.tracking_data?.shipment_track_activities ?? [];
  }

  /** Register a webhook URL; returns the provider secret if one is issued. */
  async registerWebhook(
    webhookUrl: string,
  ): Promise<{ secret: string | null }> {
    const data = await this.authed<{ secret?: string; token?: string }>(
      'POST',
      '/webhooks/create',
      { webhook_url: webhookUrl },
    );
    return { secret: data.secret ?? data.token ?? null };
  }
}

interface RawCourier {
  courier_company_id?: number | string;
  courier_name?: string;
  rate?: number | string;
  freight_charge?: number | string;
  estimated_delivery_days?: string | number | null;
  etd?: string | number | null;
}

interface RawAwb {
  awb_code?: string | number;
  courier_name?: string;
  courier_company_id?: number | string;
}

export interface RawTrackActivity {
  date?: string;
  status?: string;
  activity?: string;
  location?: string;
  'sr-status'?: string;
  'sr-status-label'?: string;
}

/** Parse Shiprocket ETA which may be `"3"`, `"3-5"`, `"3-5 Days"`, or null. */
export function parseEta(raw: string | number | null): number {
  if (raw === null || raw === undefined) return 5;
  const digits = String(raw).match(/\d+/g);
  if (!digits || digits.length === 0) return 5;
  // Range → take the upper bound (conservative ETA).
  return Number(digits[digits.length - 1]);
}
