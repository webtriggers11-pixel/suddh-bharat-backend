import { createHmac } from 'node:crypto';
import {
  BadGatewayException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { RazorpayClient } from './razorpay.client';
import { StoreConfigService } from '../store-config/store-config.service';

const SECRET = 'test_secret';
function makeClient(creds: { keyId: string; keySecret: string } | null) {
  const store = { razorpay: () => creds } as unknown as StoreConfigService;
  return new RazorpayClient(store);
}

describe('RazorpayClient.verifySignature', () => {
  const client = makeClient({ keyId: 'rzp_test', keySecret: SECRET });

  it('accepts a correctly-signed callback (constant-time)', () => {
    const orderId = 'order_123';
    const paymentId = 'pay_456';
    const sig = createHmac('sha256', SECRET)
      .update(`${orderId}|${paymentId}`)
      .digest('hex');
    expect(client.verifySignature(orderId, paymentId, sig)).toBe(true);
  });

  it('rejects a tampered signature', () => {
    expect(client.verifySignature('order_1', 'pay_1', 'deadbeef')).toBe(false);
  });

  it('rejects an empty signature without throwing', () => {
    expect(client.verifySignature('order_1', 'pay_1', '')).toBe(false);
  });
});

describe('RazorpayClient.createOrder', () => {
  afterEach(() => jest.restoreAllMocks());

  it('503s when the gateway is not configured', async () => {
    const client = makeClient(null);
    await expect(client.createOrder(50000, 'r1')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('rejects sub-minimum amounts before any network call', async () => {
    const client = makeClient({ keyId: 'k', keySecret: SECRET });
    const spy = jest.spyOn(global, 'fetch');
    await expect(client.createOrder(50, 'r1')).rejects.toBeInstanceOf(
      BadGatewayException,
    );
    expect(spy).not.toHaveBeenCalled();
  });

  it('posts paise + basic auth and returns the gateway order', async () => {
    const client = makeClient({ keyId: 'rzp_test', keySecret: SECRET });
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 'order_x',
          amount: 50000,
          currency: 'INR',
          status: 'created',
        }),
        { status: 200 },
      ),
    );
    const order = await client.createOrder(50000, 'SB-1');
    expect(order.id).toBe('order_x');
    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.amount).toBe(50000);
    const auth = (init as RequestInit).headers as Record<string, string>;
    expect(auth.Authorization).toBe(
      `Basic ${Buffer.from(`rzp_test:${SECRET}`).toString('base64')}`,
    );
  });

  it('maps a gateway error body to a 502', async () => {
    const client = makeClient({ keyId: 'k', keySecret: SECRET });
    jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: { description: 'bad key' } }), {
        status: 401,
      }),
    );
    await expect(client.createOrder(50000, 'r1')).rejects.toBeInstanceOf(
      BadGatewayException,
    );
  });
});
