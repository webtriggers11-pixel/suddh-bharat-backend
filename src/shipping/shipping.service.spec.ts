import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { OrderStatus } from '@prisma/client';
import { ShippingService } from './shipping.service';
import { PrismaService } from '../prisma/prisma.service';
import { StoreConfigService } from '../store-config/store-config.service';
import { ShiprocketClient } from './shiprocket.client';

const PICKUP = {
  location: 'Primary',
  name: 'Shuddha',
  phone: '9999999999',
  address: 'Warehouse',
  city: 'Pune',
  state: 'MH',
  pincode: '411001',
  country: 'India',
};

describe('ShippingService', () => {
  let prisma: {
    order: { findFirst: jest.Mock };
  };
  let store: { pickup: jest.Mock };
  let shiprocket: { serviceability: jest.Mock };
  let service: ShippingService;

  beforeEach(() => {
    prisma = { order: { findFirst: jest.fn() } };
    store = { pickup: jest.fn().mockReturnValue(PICKUP) };
    shiprocket = { serviceability: jest.fn() };
    service = new ShippingService(
      prisma as unknown as PrismaService,
      store as unknown as StoreConfigService,
      shiprocket as unknown as ShiprocketClient,
    );
  });

  describe('buildPackage', () => {
    it('sums weight × qty and takes max dims with a floor', () => {
      const pkg = service.buildPackage([
        { weightKg: 1, lengthCm: 20, breadthCm: 8, heightCm: 6, quantity: 2 },
        { weightKg: 0.5, lengthCm: 5, breadthCm: 30, heightCm: 4, quantity: 1 },
      ]);
      expect(pkg.weightKg).toBe(2.5);
      expect(pkg.lengthCm).toBe(20);
      expect(pkg.breadthCm).toBe(30);
      expect(pkg.heightCm).toBe(6); // >= default 5
    });

    it('applies default weight for null and never returns a zero package', () => {
      const pkg = service.buildPackage([
        {
          weightKg: null,
          lengthCm: null,
          breadthCm: null,
          heightCm: null,
          quantity: 1,
        },
      ]);
      expect(pkg.weightKg).toBe(0.5);
      expect(pkg.lengthCm).toBe(10);
      expect(pkg.heightCm).toBe(5);
    });
  });

  describe('getLiveRate', () => {
    const pkg = { weightKg: 1, lengthCm: 10, breadthCm: 10, heightCm: 5 };

    it('503s when the pickup pincode is not configured', async () => {
      store.pickup.mockReturnValue({ ...PICKUP, pincode: '' });
      await expect(
        service.getLiveRate('110001', pkg, false),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
    });

    it('400s for an invalid delivery pincode', async () => {
      await expect(
        service.getLiveRate('12', pkg, false),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('quotes the cheapest courier in paise with an ISO ETA', async () => {
      shiprocket.serviceability.mockResolvedValue([
        { courierId: '2', courierName: 'B', rate: 60, estimatedDays: 3 },
        { courierId: '1', courierName: 'A', rate: 90, estimatedDays: 4 },
      ]);
      const quote = await service.getLiveRate('110001', pkg, false);
      expect(quote.rateMinor).toBe(6000);
      expect(quote.courierName).toBe('B');
      expect(quote.estimatedDays).toBe(3);
      expect(new Date(quote.estimatedDelivery).toString()).not.toBe(
        'Invalid Date',
      );
    });
  });

  describe('createShipment guards', () => {
    it('404s for a missing order', async () => {
      prisma.order.findFirst.mockResolvedValue(null);
      await expect(service.createShipment('o1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('rejects an order that is not confirmed/processing', async () => {
      prisma.order.findFirst.mockResolvedValue({
        id: 'o1',
        status: OrderStatus.PLACED,
        items: [],
        payments: [],
        shipment: null,
      });
      await expect(service.createShipment('o1')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('409s when a shipment with an AWB already exists', async () => {
      prisma.order.findFirst.mockResolvedValue({
        id: 'o1',
        status: OrderStatus.CONFIRMED,
        items: [],
        payments: [],
        shipment: { awbNumber: 'AWB123' },
      });
      await expect(service.createShipment('o1')).rejects.toBeInstanceOf(
        ConflictException,
      );
    });
  });
});
