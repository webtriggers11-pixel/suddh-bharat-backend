import {
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MinLength,
} from 'class-validator';

// E.164-ish phone (e.g. +919812345678)
const PHONE = /^\+?[1-9]\d{7,14}$/;

export class RegisterDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(8, { message: 'Password must be at least 8 characters' })
  password!: string;

  @IsOptional()
  @IsString()
  name?: string;
}

export class LoginDto {
  @IsEmail()
  email!: string;

  @IsString()
  @IsNotEmpty()
  password!: string;
}

export class RefreshDto {
  @IsString()
  @IsNotEmpty()
  refreshToken!: string;
}

export class RequestOtpDto {
  @Matches(PHONE, { message: 'phone must be a valid E.164 number' })
  phone!: string;
}

export class VerifyOtpDto {
  @Matches(PHONE, { message: 'phone must be a valid E.164 number' })
  phone!: string;

  @IsString()
  @Matches(/^\d{4,8}$/, { message: 'code must be 4–8 digits' })
  code!: string;
}
