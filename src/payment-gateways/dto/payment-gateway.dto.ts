import {
  IsBoolean,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CreatePaymentGatewayDto {
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  provider!: string; // e.g. "razorpay"

  @IsString()
  @MinLength(1)
  @MaxLength(100)
  displayName!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  keyId!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(500)
  keySecret!: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsBoolean()
  isTestMode?: boolean;
}

export class UpdatePaymentGatewayDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  displayName?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  keyId?: string;

  // Leave blank/undefined to keep the existing secret.
  @IsOptional()
  @IsString()
  @MaxLength(500)
  keySecret?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsBoolean()
  isTestMode?: boolean;
}
