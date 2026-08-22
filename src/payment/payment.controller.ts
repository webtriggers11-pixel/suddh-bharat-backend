import { Body, Controller, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/decorators/current-user.decorator';
import { PaymentService } from './payment.service';
import { InitiatePaymentDto, VerifyPaymentDto } from './dto/payment.dto';

/** Razorpay payment endpoints. Both require a valid access token. */
// Payment endpoints move money — keep a tight per-IP ceiling.
@Throttle({ default: { limit: 30, ttl: 60_000 } })
@Controller('payment')
export class PaymentController {
  constructor(private readonly payment: PaymentService) {}

  /** Create a Razorpay order for a PENDING online order. */
  @Post('initiate')
  initiate(@CurrentUser() user: AuthUser, @Body() dto: InitiatePaymentDto) {
    return this.payment.initiate(user.id, dto);
  }

  /** Verify the checkout callback signature and advance the order to PLACED. */
  @Post('verify')
  verify(@CurrentUser() user: AuthUser, @Body() dto: VerifyPaymentDto) {
    return this.payment.verify(user.id, dto);
  }
}
