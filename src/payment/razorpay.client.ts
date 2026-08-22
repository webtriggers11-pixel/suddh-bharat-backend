import {
  BadGatewayException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { StoreConfigService } from '../store-config/store-config.service';

const RAZORPAY_BASE = 'https://api.razorpay.com/v1';

export interface RazorpayOrder {
  id: string;
  amount: number;
  currency: string;
  receipt?: string;
  status: string;
}

/**
 * Razorpay REST client (no SDK). Orders are created with HTTP basic auth
 * (key_id:key_secret); payment signatures are verified locally with HMAC-SHA256
 * in constant time. Creds come from env via StoreConfigService.
 */
@Injectable()
export class RazorpayClient {
  private readonly logger = new Logger(RazorpayClient.name);

  constructor(private readonly store: StoreConfigService) {}

  private creds(): { keyId: string; keySecret: string } {
    const c = this.store.razorpay();
    if (!c) {
      throw new ServiceUnavailableException(
        'Payment gateway is not configured',
      );
    }
    return c;
  }

  /** The public key id — safe to hand to the browser SDK. */
  publicKeyId(): string {
    return this.creds().keyId;
  }

  /** Create a Razorpay order. `amountPaise` must be a positive integer. */
  async createOrder(
    amountPaise: number,
    receipt: string,
    currency = 'INR',
  ): Promise<RazorpayOrder> {
    if (!Number.isInteger(amountPaise) || amountPaise < 100) {
      // Razorpay rejects amounts below 100 paise (₹1).
      throw new BadGatewayException(
        'Order amount is below the gateway minimum',
      );
    }
    const { keyId, keySecret } = this.creds();
    const auth = Buffer.from(`${keyId}:${keySecret}`).toString('base64');

    let res: Response;
    try {
      res = await fetch(`${RAZORPAY_BASE}/orders`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Basic ${auth}`,
        },
        body: JSON.stringify({
          amount: amountPaise,
          currency,
          receipt,
          payment_capture: 1,
        }),
        // Never let a hung gateway tie up the request/worker indefinitely.
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      this.logger.error(`Razorpay create order network error: ${String(err)}`);
      throw new BadGatewayException('Could not reach the payment gateway');
    }

    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }

    if (!res.ok) {
      const message = extractRazorpayError(parsed) ?? `HTTP ${res.status}`;
      this.logger.warn(
        `Razorpay create order failed: ${res.status} ${message}`,
      );
      throw new BadGatewayException(`Payment gateway error: ${message}`);
    }
    const order = parsed as RazorpayOrder;
    if (!order?.id) {
      throw new BadGatewayException(
        'Payment gateway did not return an order id',
      );
    }
    return order;
  }

  /**
   * Verify a checkout callback signature: HMAC-SHA256 of `"{orderId}|{paymentId}"`
   * with the key secret, compared in constant time. Returns true on match.
   */
  verifySignature(
    razorpayOrderId: string,
    razorpayPaymentId: string,
    signature: string,
  ): boolean {
    const { keySecret } = this.creds();
    const expected = createHmac('sha256', keySecret)
      .update(`${razorpayOrderId}|${razorpayPaymentId}`)
      .digest('hex');
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(signature ?? '', 'utf8');
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  /**
   * Verify an incoming Razorpay WEBHOOK: HMAC-SHA256 of the RAW request body
   * with the dashboard webhook secret, compared to `X-Razorpay-Signature` in
   * constant time. Distinct from the checkout-callback secret (key secret).
   * Returns false when no webhook secret is configured (fail closed).
   */
  verifyWebhookSignature(
    rawBody: string,
    signature: string | undefined,
  ): boolean {
    const secret = this.store.razorpayWebhookSecret();
    if (!secret || !signature) return false;
    const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(signature, 'utf8');
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }
}

function extractRazorpayError(parsed: unknown): string | null {
  if (parsed && typeof parsed === 'object') {
    const err = (parsed as { error?: { description?: string } }).error;
    if (err?.description) return err.description;
  }
  return typeof parsed === 'string' ? parsed : null;
}
