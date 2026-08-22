import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { Role } from '@prisma/client';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from '../auth/decorators/public.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { WebhooksService } from './webhooks.service';

/** Provider webhooks. Shiprocket only. */
@Controller('webhooks')
export class WebhooksController {
  constructor(private readonly webhooks: WebhooksService) {}

  /**
   * Shiprocket tracking webhook. ALWAYS returns 200 (even on auth failure) to
   * avoid provider retry storms; the body reports whether it was processed.
   */
  @Public()
  @SkipThrottle() // provider retries/bursts must not be rate-limited away
  @Post('shiprocket')
  @HttpCode(200)
  async shiprocket(
    @Headers('x-shiprocket-token') token: string | undefined,
    @Body() body: Record<string, unknown>,
  ) {
    // Never throw — the service returns a result object either way.
    try {
      return await this.webhooks.handleShiprocket(token, body ?? {});
    } catch {
      return { received: false, reason: 'error' };
    }
  }

  /**
   * Razorpay payment webhook — the capture fallback when the browser never calls
   * /payment/verify. Verifies the HMAC over the RAW body. ALWAYS 200 so Razorpay
   * doesn't hammer us with retries; the body reports what happened.
   */
  @Public()
  @SkipThrottle()
  @Post('razorpay')
  @HttpCode(200)
  async razorpay(
    @Headers('x-razorpay-signature') signature: string | undefined,
    @Req() req: RawBodyRequest<Request>,
    @Body() body: Record<string, unknown>,
  ) {
    try {
      const rawBody = req.rawBody?.toString('utf8') ?? '';
      return await this.webhooks.handleRazorpay(signature, rawBody, body ?? {});
    } catch {
      return { received: false, reason: 'error' };
    }
  }

  /** Register the webhook URL with Shiprocket (admin). */
  @Roles(Role.ADMIN, Role.SUPERADMIN)
  @Post('shiprocket/register')
  register(@Query('webhook_url') webhookUrl: string) {
    return this.webhooks.register(webhookUrl);
  }
}
