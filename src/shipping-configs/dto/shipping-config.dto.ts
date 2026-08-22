import {
  IsBoolean,
  IsEmail,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CreateShippingConfigDto {
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  provider!: string; // e.g. "shiprocket"

  @IsString()
  @MinLength(1)
  @MaxLength(100)
  displayName!: string;

  @IsEmail()
  apiEmail!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  apiPassword!: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsBoolean()
  isTestMode?: boolean;
}

export class UpdateShippingConfigDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  displayName?: string;

  @IsOptional()
  @IsEmail()
  apiEmail?: string;

  // Leave blank/undefined to keep the existing password.
  @IsOptional()
  @IsString()
  @MaxLength(200)
  apiPassword?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsBoolean()
  isTestMode?: boolean;
}

export class RegisterWebhookDto {
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  webhookUrl!: string;
}
