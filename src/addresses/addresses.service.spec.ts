import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Address, AddressType } from '@prisma/client';
import { AddressesService } from './addresses.service';
import { PrismaService } from '../prisma/prisma.service';

function makeAddress(over: Partial<Address> = {}): Address {
  return {
    id: 'a1',
    userId: 'u1',
    type: AddressType.HOME,
    fullName: 'User',
    phone: '9876543210',
    line1: '1 Road',
    line2: null,
    city: 'Pune',
    state: 'MH',
    pincode: '411001',
    isDefault: false,
    isLocked: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    ...over,
  };
}

describe('AddressesService', () => {
  let prisma: {
    address: {
      findMany: jest.Mock;
      findFirst: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
      updateMany: jest.Mock;
    };
  };
  let service: AddressesService;

  const dto = {
    fullName: 'User',
    phone: '9876543210',
    line1: '1 Road',
    city: 'Pune',
    state: 'MH',
    pincode: '411001',
  };

  beforeEach(() => {
    prisma = {
      address: {
        findMany: jest.fn(),
        findFirst: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
      },
    };
    service = new AddressesService(prisma as unknown as PrismaService);
  });

  describe('create', () => {
    it('returns the existing address on a duplicate (de-dupe)', async () => {
      prisma.address.findFirst
        .mockResolvedValueOnce(makeAddress()) // dedupe hit
        .mockResolvedValueOnce(makeAddress()); // get() for return
      const result = await service.create('u1', dto);
      expect(result.id).toBe('a1');
      expect(prisma.address.create).not.toHaveBeenCalled();
    });

    it('clears other defaults when creating a default address', async () => {
      prisma.address.findFirst.mockResolvedValue(null); // no dupe
      prisma.address.create.mockResolvedValue(makeAddress({ isDefault: true }));
      await service.create('u1', { ...dto, isDefault: true });
      expect(prisma.address.updateMany).toHaveBeenCalledWith({
        where: { userId: 'u1', isDefault: true, deletedAt: null },
        data: { isDefault: false },
      });
    });
  });

  describe('update', () => {
    it('403s when the address is locked to an order', async () => {
      prisma.address.findFirst.mockResolvedValue(
        makeAddress({ isLocked: true }),
      );
      await expect(
        service.update('u1', 'a1', { city: 'Mumbai' }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('get', () => {
    it('404s for an address the user does not own', async () => {
      prisma.address.findFirst.mockResolvedValue(null);
      await expect(service.get('u1', 'x')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('setDefault', () => {
    it('clears others then sets this one default (no lock check)', async () => {
      prisma.address.findFirst.mockResolvedValue(
        makeAddress({ isLocked: true }),
      );
      prisma.address.update.mockResolvedValue(makeAddress({ isDefault: true }));
      const result = await service.setDefault('u1', 'a1');
      expect(prisma.address.updateMany).toHaveBeenCalled();
      expect(result.isDefault).toBe(true);
    });
  });
});
