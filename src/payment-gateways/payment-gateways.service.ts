import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PaymentGateway } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
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
  constructor(private readonly prisma: PrismaService) {}

  async list() {
    const rows = await this.prisma.paymentGateway.findMany({
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(toPublicGateway);
  }

  async create(dto: CreatePaymentGatewayDto) {
    const provider = dto.provider.trim().toLowerCase();
    const existing = await this.prisma.paymentGateway.findUnique({
      where: { provider },
    });
    if (existing) {
      throw new ConflictException(
        `A "${provider}" gateway is already configured`,
      );
    }
    const created = await this.prisma.paymentGateway.create({
      data: {
        provider,
        displayName: dto.displayName,
        keyId: dto.keyId,
        keySecret: dto.keySecret,
        isActive: dto.isActive ?? true,
        isTestMode: dto.isTestMode ?? false,
      },
    });
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
        ...(dto.keySecret ? { keySecret: dto.keySecret } : {}),
        isActive: dto.isActive,
        isTestMode: dto.isTestMode,
      },
    });
    return toPublicGateway(updated);
  }

  async remove(id: string) {
    await this.getOrThrow(id);
    await this.prisma.paymentGateway.delete({ where: { id } });
    return { success: true };
  }

  private async getOrThrow(id: string): Promise<PaymentGateway> {
    const gateway = await this.prisma.paymentGateway.findUnique({
      where: { id },
    });
    if (!gateway) throw new NotFoundException('Payment gateway not found');
    return gateway;
  }
}
