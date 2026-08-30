import { Injectable } from '@nestjs/common';
import { PaymentGateway } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { StoreConfigService } from '../store-config/store-config.service';
import { encryptSecret } from '../common/secret-crypto.util';
import {
  assertProviderFree,
  getRowOrThrow,
  normalizeProviderKey,
} from '../common/provider-credentials.util';
import {
  CreatePaymentGatewayDto,
  UpdatePaymentGatewayDto,
} from './dto/payment-gateway.dto';

/** Public projection — the key secret is write-only and never returned. */
export function toPublicGateway(g: PaymentGateway) {
  return {
    id: g.id,
    provider: g.provider,
    displayName: g.displayName,
    keyId: g.keyId,
    isActive: g.isActive,
    isTestMode: g.isTestMode,
    createdAt: g.createdAt,
    updatedAt: g.updatedAt,
  };
}

/** CRUD for payment-provider credentials (spec 09). ADMIN/SUPERADMIN. */
@Injectable()
export class PaymentGatewaysService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storeConfig: StoreConfigService,
  ) {}

  async list() {
    const rows = await this.prisma.paymentGateway.findMany({
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(toPublicGateway);
  }

  async create(dto: CreatePaymentGatewayDto) {
    const provider = normalizeProviderKey(dto.provider);
    await assertProviderFree(
      (p) => this.prisma.paymentGateway.findUnique({ where: { provider: p } }),
      provider,
      'gateway',
    );
    const created = await this.prisma.paymentGateway.create({
      data: {
        provider,
        displayName: dto.displayName,
        keyId: dto.keyId,
        keySecret: encryptSecret(dto.keySecret),
        isActive: dto.isActive ?? true,
        isTestMode: dto.isTestMode ?? false,
      },
    });
    await this.storeConfig.refresh();
    return toPublicGateway(created);
  }

  async update(id: string, dto: UpdatePaymentGatewayDto) {
    await this.getOrThrow(id);
    const updated = await this.prisma.paymentGateway.update({
      where: { id },
      data: {
        displayName: dto.displayName,
        keyId: dto.keyId,
        // Only overwrite the secret when a non-empty value is supplied.
        ...(dto.keySecret ? { keySecret: encryptSecret(dto.keySecret) } : {}),
        isActive: dto.isActive,
        isTestMode: dto.isTestMode,
      },
    });
    await this.storeConfig.refresh();
    return toPublicGateway(updated);
  }

  async remove(id: string) {
    await this.getOrThrow(id);
    await this.prisma.paymentGateway.delete({ where: { id } });
    await this.storeConfig.refresh();
    return { success: true };
  }

  private getOrThrow(id: string): Promise<PaymentGateway> {
    return getRowOrThrow(
      (rowId) =>
        this.prisma.paymentGateway.findUnique({ where: { id: rowId } }),
      id,
      'Payment gateway',
    );
  }
}
