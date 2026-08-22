import { ConflictException, NotFoundException } from '@nestjs/common';
import { PaymentGatewaysService } from './payment-gateways.service';
import { PrismaService } from '../prisma/prisma.service';

const baseRow = {
  id: 'g1',
  provider: 'razorpay',
  displayName: 'Razorpay Live',
  keyId: 'rzp_key',
  keySecret: 'super-secret',
  isActive: true,
  isTestMode: false,
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe('PaymentGatewaysService', () => {
  let prisma: {
    paymentGateway: {
      findMany: jest.Mock;
      findUnique: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
      delete: jest.Mock;
    };
  };
  let service: PaymentGatewaysService;

  beforeEach(() => {
    prisma = {
      paymentGateway: {
        findMany: jest.fn().mockResolvedValue([baseRow]),
        findUnique: jest.fn(),
        create: jest.fn().mockResolvedValue(baseRow),
        update: jest.fn().mockResolvedValue(baseRow),
        delete: jest.fn().mockResolvedValue(baseRow),
      },
    };
    service = new PaymentGatewaysService(prisma as unknown as PrismaService);
  });

  it('never leaks the key secret in list output', async () => {
    const rows = await service.list();
    expect(rows[0]).not.toHaveProperty('keySecret');
    expect(rows[0].keyId).toBe('rzp_key');
  });

  it('rejects a duplicate provider (409)', async () => {
    prisma.paymentGateway.findUnique.mockResolvedValue(baseRow);
    await expect(
      service.create({
        provider: 'Razorpay',
        displayName: 'x',
        keyId: 'k',
        keySecret: 's',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('lowercases the provider key on create', async () => {
    prisma.paymentGateway.findUnique.mockResolvedValue(null);
    await service.create({
      provider: 'RazorPay',
      displayName: 'x',
      keyId: 'k',
      keySecret: 's',
    });
    expect(prisma.paymentGateway.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ provider: 'razorpay' }),
      }),
    );
  });

  it('keeps the existing secret when update omits keySecret', async () => {
    prisma.paymentGateway.findUnique.mockResolvedValue(baseRow);
    await service.update('g1', { displayName: 'New name' });
    const dataArg = prisma.paymentGateway.update.mock.calls[0][0].data;
    expect(dataArg).not.toHaveProperty('keySecret');
  });

  it('overwrites the secret when update supplies one', async () => {
    prisma.paymentGateway.findUnique.mockResolvedValue(baseRow);
    await service.update('g1', { keySecret: 'rotated' });
    const dataArg = prisma.paymentGateway.update.mock.calls[0][0].data;
    expect(dataArg.keySecret).toBe('rotated');
  });

  it('throws NotFound deleting a missing gateway', async () => {
    prisma.paymentGateway.findUnique.mockResolvedValue(null);
    await expect(service.remove('nope')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
