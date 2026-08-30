import { BadGatewayException, Injectable, Logger } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { ShippingConfig } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { StoreConfigService } from '../store-config/store-config.service';
import { StoreSettingsService } from '../store-settings/store-settings.service';
import { decryptSecret, encryptSecret } from '../common/secret-crypto.util';
import {
  assertProviderFree,
  getRowOrThrow,
  normalizeProviderKey,
} from '../common/provider-credentials.util';
import {
  CreateShippingConfigDto,
  RegisterWebhookDto,
  UpdateShippingConfigDto,
} from './dto/shipping-config.dto';

interface LoginResponse {
  token?: string;
  message?: string;
}

interface PickupAddress {
  pickup_location?: string;
  name?: string;
  phone?: string | number;
  address?: string;
  address_2?: string;
  city?: string;
  state?: string;
  pin_code?: string | number;
  country?: string;
}

interface PickupResponse {
  data?: { shipping_address?: PickupAddress[] };
  shipping_address?: PickupAddress[];
  message?: string;
}

/** Public projection — password/webhook secret are write-only. `hasToken` and
 *  the token expiry are surfaced so the UI can show a "Valid" badge. */
export function toPublicConfig(c: ShippingConfig) {
  return {
    id: c.id,
    provider: c.provider,
    displayName: c.displayName,
    apiEmail: c.apiEmail,
    hasToken: Boolean(c.token),
    tokenExpiresAt: c.tokenExpiresAt,
    hasWebhookSecret: Boolean(c.webhookSecret),
    isActive: c.isActive,
    isTestMode: c.isTestMode,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

/** CRUD + connection/pickup/webhook actions for shipping providers (spec 10). */
@Injectable()
export class ShippingConfigsService {
  private readonly logger = new Logger(ShippingConfigsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storeConfig: StoreConfigService,
    private readonly storeSettings: StoreSettingsService,
  ) {}

  async list() {
    const rows = await this.prisma.shippingConfig.findMany({
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(toPublicConfig);
  }

  async create(dto: CreateShippingConfigDto) {
    const provider = normalizeProviderKey(dto.provider);
    await assertProviderFree(
      (p) => this.prisma.shippingConfig.findUnique({ where: { provider: p } }),
      provider,
      'provider',
    );
    const created = await this.prisma.shippingConfig.create({
      data: {
        provider,
        displayName: dto.displayName,
        apiEmail: dto.apiEmail,
        apiPassword: encryptSecret(dto.apiPassword),
        isActive: dto.isActive ?? true,
        isTestMode: dto.isTestMode ?? false,
      },
    });
    await this.storeConfig.refresh();
    return toPublicConfig(created);
  }

  async update(id: string, dto: UpdateShippingConfigDto) {
    await this.getOrThrow(id);
    const updated = await this.prisma.shippingConfig.update({
      where: { id },
      data: {
        displayName: dto.displayName,
        apiEmail: dto.apiEmail,
        ...(dto.apiPassword
          ? { apiPassword: encryptSecret(dto.apiPassword) }
          : {}),
        isActive: dto.isActive,
        isTestMode: dto.isTestMode,
      },
    });
    await this.storeConfig.refresh();
    return toPublicConfig(updated);
  }

  async remove(id: string) {
    await this.getOrThrow(id);
    await this.prisma.shippingConfig.delete({ where: { id } });
    await this.storeConfig.refresh();
    return { success: true };
  }

  /** Verify credentials by logging in; caches the returned token. */
  async testConnection(
    id: string,
  ): Promise<{ success: boolean; message: string }> {
    const config = await this.getOrThrow(id);
    try {
      const { token, expiresAt } = await this.login(config);
      await this.prisma.shippingConfig.update({
        where: { id },
        data: { token, tokenExpiresAt: expiresAt },
      });
      return {
        success: true,
        message: 'Connection verified — token refreshed.',
      };
    } catch (err) {
      return { success: false, message: this.errText(err) };
    }
  }

  /** Pull the first pickup location and persist it to store settings. */
  async syncPickup(id: string) {
    const config = await this.getOrThrow(id);
    const { token } = await this.login(config);
    const base = this.storeConfig.shiprocketBaseUrl();
    const res = await this.fetchJson<PickupResponse>(
      `${base}/settings/company/pickup`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const addresses =
      res?.data?.shipping_address ?? res?.shipping_address ?? [];
    if (!addresses.length) {
      throw new BadGatewayException(
        'No pickup locations found on the provider',
      );
    }
    const a = addresses[0];
    await this.storeSettings.syncPickup({
      shiprocketPickupLocation: a.pickup_location ?? null,
      pickupName: a.name ?? null,
      pickupPhone: a.phone ? String(a.phone) : null,
      pickupAddress:
        [a.address, a.address_2].filter(Boolean).join(', ') || null,
      pickupCity: a.city ?? null,
      pickupState: a.state ?? null,
      pickupPincode: a.pin_code ? String(a.pin_code) : null,
      pickupCountry: a.country ?? null,
    });
    return {
      success: true,
      location: a.pickup_location ?? '',
      pincode: a.pin_code ? String(a.pin_code) : '',
    };
  }

  /** Store a webhook secret on the config (registration handshake). */
  async registerWebhook(id: string, dto: RegisterWebhookDto) {
    await this.getOrThrow(id);
    const secret = randomBytes(24).toString('hex');
    await this.prisma.shippingConfig.update({
      where: { id },
      data: { webhookSecret: encryptSecret(secret) },
    });
    await this.storeConfig.refresh();
    this.logger.log(`Registered webhook ${dto.webhookUrl} for shipping ${id}`);
    return { success: true, message: 'Webhook registered.' };
  }

  // ---- internals -----------------------------------------------------------

  /** Reuse the cached token (`expiresAt` already bakes in a day's early-refresh
   * margin) instead of re-authenticating on every admin action. */
  private async login(
    config: ShippingConfig,
  ): Promise<{ token: string; expiresAt: Date }> {
    if (
      config.token &&
      config.tokenExpiresAt &&
      config.tokenExpiresAt > new Date()
    ) {
      return { token: config.token, expiresAt: config.tokenExpiresAt };
    }
    const base = this.storeConfig.shiprocketBaseUrl();
    const data = await this.fetchJson<LoginResponse>(`${base}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: config.apiEmail,
        password: decryptSecret(config.apiPassword),
      }),
    });
    if (!data?.token) {
      throw new BadGatewayException(
        data?.message ?? 'Provider did not return a token',
      );
    }
    // Shiprocket tokens last ~10 days; refresh a day early.
    const expiresAt = new Date(Date.now() + 9 * 24 * 3600 * 1000);
    return { token: data.token, expiresAt };
  }

  private async fetchJson<T>(url: string, init: RequestInit): Promise<T> {
    const res = await fetch(url, init);
    const text = await res.text();
    let json: (T & { message?: string }) | null = null;
    try {
      json = text ? (JSON.parse(text) as T & { message?: string }) : null;
    } catch {
      // non-JSON body
    }
    if (!res.ok) {
      throw new BadGatewayException(
        json?.message ?? `Provider responded ${res.status}`,
      );
    }
    return json as T;
  }

  private errText(err: unknown): string {
    if (err instanceof Error) return err.message;
    return String(err);
  }

  private getOrThrow(id: string): Promise<ShippingConfig> {
    return getRowOrThrow(
      (rowId) =>
        this.prisma.shippingConfig.findUnique({ where: { id: rowId } }),
      id,
      'Shipping provider',
    );
  }
}
