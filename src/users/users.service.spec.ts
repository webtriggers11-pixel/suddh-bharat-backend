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

describe('UsersService admin management', () => {
  let prisma: {
    user: {
      findUnique: jest.Mock;
      findMany: jest.Mock;
      count: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
    };
  };
  let service: UsersService;

  beforeEach(() => {
    prisma = {
      user: {
        findUnique: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        create: jest.fn().mockResolvedValue({ id: 'a1', roles: ['ADMIN'] }),
        update: jest.fn().mockResolvedValue({ id: 'u1', isActive: false }),
      },
    };
    service = new UsersService(prisma as unknown as PrismaService);
  });

  it('paginates and returns a page envelope', async () => {
    prisma.user.count.mockResolvedValue(42);
    const res = await service.adminList({ page: 2, pageSize: 20 });
    expect(res.total).toBe(42);
    expect(res.totalPages).toBe(3);
    expect(prisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 20, take: 20 }),
    );
  });

  it('creates an ADMIN with a hashed password', async () => {
    prisma.user.findUnique.mockResolvedValue(null); // findByEmail
    await service.createAdmin({
      name: 'New Admin',
      email: 'New@Admin.in',
      password: 'Password123!',
    });
    const data = prisma.user.create.mock.calls[0][0].data;
    expect(data.email).toBe('new@admin.in');
    expect(data.roles).toEqual(['ADMIN']);
    expect(data.passwordHash).not.toBe('Password123!');
  });

  it('rejects a duplicate admin email', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 'exists' });
    await expect(
      service.createAdmin({
        name: 'x',
        email: 'a@b.in',
        password: 'Password1!',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('toggles active state', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 'u1' });
    await service.setActive('u1', false);
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { isActive: false } }),
    );
  });
});
