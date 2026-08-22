import { Injectable } from '@nestjs/common';
import { StoreSettings } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { UpdateStoreSettingsDto } from './dto/store-settings.dto';

const SINGLETON_ID = 'singleton';

/**
 * Admin-editable store settings (spec 08). A single persisted row; the pickup
 * address fields are synced from the shipping provider (read-only in the UI).
 */
@Injectable()
export class StoreSettingsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Return the singleton, seeding sensible defaults on first read. */
  async get(): Promise<StoreSettings> {
    return this.prisma.storeSettings.upsert({
      where: { id: SINGLETON_ID },
      update: {},
      create: { id: SINGLETON_ID },
    });
  }

  async update(dto: UpdateStoreSettingsDto): Promise<StoreSettings> {
    await this.get(); // ensure the row exists
    return this.prisma.storeSettings.update({
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
    return this.prisma.storeSettings.update({
      where: { id: SINGLETON_ID },
      data: pickup,
    });
  }
}
