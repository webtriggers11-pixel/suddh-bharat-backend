import { Injectable } from '@nestjs/common';
import { StoreSettings } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { StoreConfigService } from '../store-config/store-config.service';
import { UpdateStoreSettingsDto } from './dto/store-settings.dto';

const SINGLETON_ID = 'singleton';

/**
 * Admin-editable store settings (spec 08). A single persisted row; the pickup
 * address fields are synced from the shipping provider (read-only in the UI).
 */
@Injectable()
export class StoreSettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storeConfig: StoreConfigService,
  ) {}

  /** Return the singleton, seeding it from the current env-configured policy
   * on first read (rather than bare column defaults) so simply opening this
   * page doesn't silently change live shipping/COD behaviour — e.g. dropping
   * an env-configured free-shipping threshold to "never free" just because no
   * row existed yet. */
  async get(): Promise<StoreSettings> {
    const policy = this.storeConfig.shippingPolicy();
    const row = await this.prisma.storeSettings.upsert({
      where: { id: SINGLETON_ID },
      update: {},
      create: {
        id: SINGLETON_ID,
        codEnabled: policy.codEnabled,
        codChargeMinor: policy.codChargeMinor,
        freeShippingThresholdMinor: policy.freeShippingThresholdMinor,
        minOrderMinor: policy.minOrderMinor,
      },
    });
    await this.storeConfig.refresh();
    return row;
  }

  async update(dto: UpdateStoreSettingsDto): Promise<StoreSettings> {
    await this.get(); // ensure the row exists
    const row = await this.prisma.storeSettings.update({
      where: { id: SINGLETON_ID },
      data: {
        codEnabled: dto.codEnabled,
        codChargeMinor: dto.codChargeMinor,
        // `freeShippingThresholdMinor` is nullable — an explicit null clears it.
        ...(dto.freeShippingThresholdMinor !== undefined
          ? { freeShippingThresholdMinor: dto.freeShippingThresholdMinor }
          : {}),
        minOrderMinor: dto.minOrderMinor,
      },
    });
    await this.storeConfig.refresh();
    return row;
  }

  /** Persist the pickup address synced from a shipping provider. */
  async syncPickup(pickup: {
    shiprocketPickupLocation?: string | null;
    pickupName?: string | null;
    pickupPhone?: string | null;
    pickupAddress?: string | null;
    pickupCity?: string | null;
    pickupState?: string | null;
    pickupPincode?: string | null;
    pickupCountry?: string | null;
  }): Promise<StoreSettings> {
    await this.get();
    const row = await this.prisma.storeSettings.update({
      where: { id: SINGLETON_ID },
      data: pickup,
    });
    await this.storeConfig.refresh();
    return row;
  }
}
