import { AddressType } from '@prisma/client';
import {
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  Length,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CreateAddressDto {
  @IsOptional()
  @IsEnum(AddressType)
  type?: AddressType;

  @IsString()
  @MinLength(1)
  @MaxLength(100)
  fullName!: string;

  @IsString()
  @Length(7, 15)
  phone!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(255)
  line1!: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  line2?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(100)
  city!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(100)
  state!: string;

  @IsString()
  @Length(4, 10)
  pincode!: string;

  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;
}

export class UpdateAddressDto {
  @IsOptional()
  @IsEnum(AddressType)
  type?: AddressType;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  fullName?: string;

  @IsOptional()
  @IsString()
  @Length(7, 15)
  phone?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  line1?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  line2?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  city?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  state?: string;

  @IsOptional()
  @IsString()
  @Length(4, 10)
  pincode?: string;

  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;
}
