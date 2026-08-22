import {
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ShiprocketClient, parseEta } from './shiprocket.client';
import { StoreConfigService } from '../store-config/store-config.service';

describe('parseEta', () => {
  it('parses single, range, and noisy values', () => {
    expect(parseEta('3')).toBe(3);
    expect(parseEta('3-5')).toBe(5); // upper bound (conservative)
    expect(parseEta('2-4 Days')).toBe(4);
    expect(parseEta(6)).toBe(6);
  });
  it('defaults to 5 when unparseable', () => {
    expect(parseEta(null)).toBe(5);
    expect(parseEta('soon')).toBe(5);
  });
});

type FakeRedis = {
  get: jest.Mock;
  set: jest.Mock;
  del: jest.Mock;
};

function makeRedis(): FakeRedis {
  return {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue('OK'),
    del: jest.fn().mockResolvedValue(1),
  };
}

function makeClient(
  creds: { email: string; password: string } | null,
  redis: FakeRedis | null = null,
) {
  const store = {
    shiprocketBaseUrl: () => 'https://sr.test/v1/external',
    shiprocketCredentials: () => creds,
  } as unknown as StoreConfigService;
  return new ShiprocketClient(
    store,
    redis as unknown as import('ioredis').Redis | null,
  );
}

const serviceabilityBody = (rate = 50) =>
  jsonResponse({
    data: {
      available_courier_companies: [
        { courier_company_id: 1, courier_name: 'A', rate, etd: '3' },
      ],
    },
  });
const SERVICE_REQ = {
  pickupPincode: '411001',
  deliveryPincode: '110001',
  weightKg: 1,
  cod: false,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe('ShiprocketClient', () => {
  afterEach(() => jest.restoreAllMocks());

  it('503s when credentials are missing', async () => {
    const client = makeClient(null);
    await expect(
      client.serviceability({
        pickupPincode: '411001',
        deliveryPincode: '110001',
        weightKg: 1,
        cod: false,
      }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('returns couriers cheapest-first and drops zero-rate options', async () => {
    const client = makeClient({ email: 'a@b.c', password: 'x' });
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ token: 'TKN' })) // login
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            available_courier_companies: [
              { courier_company_id: 1, courier_name: 'A', rate: 90, etd: '4' },
              {
                courier_company_id: 2,
                courier_name: 'B',
                rate: 60,
                etd: '3-5',
              },
              { courier_company_id: 3, courier_name: 'Z', rate: 0, etd: '2' },
            ],
          },
        }),
      );
    const couriers = await client.serviceability({
      pickupPincode: '411001',
      deliveryPincode: '110001',
      weightKg: 1,
      cod: false,
    });
    expect(couriers.map((c) => c.courierName)).toEqual(['B', 'A']);
    expect(couriers[0].rate).toBe(60);
    expect(couriers[0].estimatedDays).toBe(5);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('throws 422 when nothing is serviceable', async () => {
    const client = makeClient({ email: 'a@b.c', password: 'x' });
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ token: 'TKN' }))
      .mockResolvedValueOnce(
        jsonResponse({ data: { available_courier_companies: [] } }),
      );
    await expect(
      client.serviceability({
        pickupPincode: '411001',
        deliveryPincode: '000000',
        weightKg: 1,
        cod: false,
      }),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it('reuses a valid token from shared Redis instead of logging in', async () => {
    const redis = makeRedis();
    redis.get.mockResolvedValue(
      JSON.stringify({
        token: 'SHARED',
        expiresAt: Date.now() + 5 * 24 * 60 * 60 * 1000, // well ahead of the 1h margin
      }),
    );
    const client = makeClient({ email: 'a@b.c', password: 'x' }, redis);
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(serviceabilityBody());

    await client.serviceability(SERVICE_REQ);

    // No /auth/login round-trip — only the serviceability GET.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // The client always calls fetch with a string URL.
    const url = fetchMock.mock.calls[0][0] as string;
    const init = fetchMock.mock.calls[0][1];
    expect(url).toContain('/courier/serviceability');
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: 'Bearer SHARED',
    });
    expect(redis.set).not.toHaveBeenCalled();
  });

  it('persists a freshly-minted token to Redis with a TTL', async () => {
    const redis = makeRedis(); // get → null, so it logs in
    const client = makeClient({ email: 'a@b.c', password: 'x' }, redis);
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ token: 'FRESH' })) // login
      .mockResolvedValue(serviceabilityBody());

    await client.serviceability(SERVICE_REQ);

    expect(redis.set).toHaveBeenCalledTimes(1);
    const [key, value, mode, ttl] = redis.set.mock.calls[0];
    expect(key).toBe('shiprocket:auth:token');
    expect(JSON.parse(value as string).token).toBe('FRESH');
    expect(mode).toBe('EX');
    expect(ttl).toBeGreaterThan(0);
  });

  it('drops the shared token from Redis on invalidateToken', () => {
    const redis = makeRedis();
    const client = makeClient({ email: 'a@b.c', password: 'x' }, redis);
    client.invalidateToken();
    expect(redis.del).toHaveBeenCalledWith('shiprocket:auth:token');
  });

  it('caches the token across calls (one login for two requests)', async () => {
    const client = makeClient({ email: 'a@b.c', password: 'x' });
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ token: 'TKN' })) // login (once)
      // Fresh Response per call — a body can only be read once.
      .mockImplementation(() =>
        Promise.resolve(
          jsonResponse({
            data: {
              available_courier_companies: [
                {
                  courier_company_id: 1,
                  courier_name: 'A',
                  rate: 50,
                  etd: '3',
                },
              ],
            },
          }),
        ),
      );
    const req = {
      pickupPincode: '411001',
      deliveryPincode: '110001',
      weightKg: 1,
      cod: false,
    };
    await client.serviceability(req);
    await client.serviceability(req);
    // 1 login + 2 serviceability = 3 (not 4).
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
