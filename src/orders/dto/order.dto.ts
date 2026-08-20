import { PaymentMethod } from '@prisma/client';
import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';

/** Checkout input. Items come from the user's cart (server-authoritative) — the
 *  client only chooses an address, payment method, and optional notes. */
export class CreateOrderDto {
  @IsString()
  addressId!: string;

  @IsEnum(PaymentMethod)
  paymentMethod!: PaymentMethod;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}
