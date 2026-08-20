import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Address } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateAddressDto, UpdateAddressDto } from './dto/address.dto';

/**
 * User address book (ADR-0010). Every query is scoped to the owner. At most one
 * default; locked addresses (snapshotted into an order) cannot be edited.
 */
@Injectable()
export class AddressesService {
  constructor(private readonly prisma: PrismaService) {}

  list(userId: string): Promise<Address[]> {
    return this.prisma.address.findMany({
      where: { userId, deletedAt: null },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
    });
  }

  async get(userId: string, id: string): Promise<Address> {
    const address = await this.prisma.address.findFirst({
      where: { id, userId, deletedAt: null },
    });
    if (!address) throw new NotFoundException('Address not found');
    return address;
  }

  async create(userId: string, dto: CreateAddressDto): Promise<Address> {
    // De-dupe on line1 + city + state + pincode (non-deleted).
    const existing = await this.prisma.address.findFirst({
      where: {
        userId,
        deletedAt: null,
        line1: dto.line1,
        city: dto.city,
        state: dto.state,
        pincode: dto.pincode,
      },
    });
    if (existing) {
      if (dto.isDefault) await this.makeDefault(userId, existing.id);
      return this.get(userId, existing.id);
    }

    if (dto.isDefault) await this.clearDefault(userId);
    return this.prisma.address.create({
      data: {
        userId,
        type: dto.type,
        fullName: dto.fullName,
        phone: dto.phone,
        line1: dto.line1,
        line2: dto.line2,
        city: dto.city,
        state: dto.state,
        pincode: dto.pincode,
        isDefault: dto.isDefault ?? false,
      },
    });
  }

  async update(
    userId: string,
    id: string,
    dto: UpdateAddressDto,
  ): Promise<Address> {
    const address = await this.get(userId, id);
    if (address.isLocked) {
      throw new ForbiddenException(
        'This address is linked to an order and cannot be edited',
      );
    }
    if (dto.isDefault) await this.clearDefault(userId);
    return this.prisma.address.update({
      where: { id },
      data: {
        type: dto.type,
        fullName: dto.fullName,
        phone: dto.phone,
        line1: dto.line1,
        line2: dto.line2,
        city: dto.city,
        state: dto.state,
        pincode: dto.pincode,
        isDefault: dto.isDefault,
      },
    });
  }

  async setDefault(userId: string, id: string): Promise<Address> {
    await this.get(userId, id); // ownership check (no lock check — allowed)
    return this.makeDefault(userId, id);
  }

  async remove(userId: string, id: string): Promise<{ id: string }> {
    await this.get(userId, id);
    await this.prisma.address.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
    return { id };
  }

  /** Set as the single default (clears all others first). */
  private async makeDefault(userId: string, id: string): Promise<Address> {
    await this.clearDefault(userId);
    return this.prisma.address.update({
      where: { id },
      data: { isDefault: true },
    });
  }

  private clearDefault(userId: string): Promise<unknown> {
    return this.prisma.address.updateMany({
      where: { userId, isDefault: true, deletedAt: null },
      data: { isDefault: false },
    });
  }
}
