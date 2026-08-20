import { ConflictException } from '@nestjs/common';
import { UsersService } from './users.service';
import { PrismaService } from '../prisma/prisma.service';

describe('UsersService.updateProfile', () => {
  let prisma: {
    user: { findFirst: jest.Mock; update: jest.Mock };
  };
  let service: UsersService;

  beforeEach(() => {
    prisma = {
      user: {
        findFirst: jest.fn(),
        update: jest.fn().mockResolvedValue({ id: 'u1', name: 'New' }),
      },
    };
    service = new UsersService(prisma as unknown as PrismaService);
  });

  it('updates name/phone when the phone is free', async () => {
    prisma.user.findFirst.mockResolvedValue(null);
    await service.updateProfile('u1', { name: 'New', phone: '9876543210' });
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'u1' },
      data: { name: 'New', phone: '9876543210' },
    });
  });

  it('rejects a phone already used by another user (409)', async () => {
    prisma.user.findFirst.mockResolvedValue({ id: 'other' });
    await expect(
      service.updateProfile('u1', { phone: '9876543210' }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('skips the uniqueness check when phone is not being changed', async () => {
    await service.updateProfile('u1', { name: 'Only Name' });
    expect(prisma.user.findFirst).not.toHaveBeenCalled();
    expect(prisma.user.update).toHaveBeenCalled();
  });
});
