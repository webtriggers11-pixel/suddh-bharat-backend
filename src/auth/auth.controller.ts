import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Throttle } from '@nestjs/throttler';
import { Role, User } from '@prisma/client';
import type { Response } from 'express';

// Per-IP limits for abuse-prone auth endpoints (spec §5). ttl in ms.
const HOUR = 3_600_000;
const MIN = 60_000;
import { AuthService } from './auth.service';
import { UsersService } from '../users/users.service';
import {
  GuestCheckoutDto,
  LoginDto,
  RefreshDto,
  RegisterDto,
  RequestOtpDto,
  VerifyOtpDto,
} from './dto/auth.dto';
import { Public } from './decorators/public.decorator';
import { Roles } from './decorators/roles.decorator';
import { CurrentUser } from './decorators/current-user.decorator';
import type { AuthUser } from './decorators/current-user.decorator';
import { GoogleAuthGuard } from './guards/google-auth.guard';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly users: UsersService,
    private readonly config: ConfigService,
  ) {}

  @Public()
  @Throttle({ default: { limit: 10, ttl: HOUR } })
  @Post('register')
  register(@Body() dto: RegisterDto) {
    return this.auth.register(dto);
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: MIN } })
  @HttpCode(200)
  @Post('login')
  login(@Body() dto: LoginDto) {
    return this.auth.login(dto);
  }

  @Public()
  @HttpCode(200)
  @Post('refresh')
  refresh(@Body() dto: RefreshDto) {
    return this.auth.refresh(dto.refreshToken);
  }

  @Public()
  @HttpCode(200)
  @Post('logout')
  async logout(@Body() dto: RefreshDto) {
    await this.auth.logout(dto.refreshToken);
    return { success: true };
  }

  @Get('me')
  async me(@CurrentUser() current: AuthUser) {
    const user = await this.users.findById(current.id);
    return user ? UsersService.toPublic(user) : current;
  }

  // ---- Phone OTP ----
  @Public()
  @Throttle({ default: { limit: 5, ttl: HOUR } })
  @HttpCode(200)
  @Post('otp/request')
  requestOtp(@Body() dto: RequestOtpDto) {
    return this.auth.requestOtp(dto.phone);
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: HOUR } })
  @HttpCode(200)
  @Post('otp/verify')
  verifyOtp(@Body() dto: VerifyOtpDto) {
    return this.auth.verifyOtp(dto.phone, dto.code);
  }

  // ---- Guest checkout (ADR-0012, zero-verification) ----
  @Public()
  @Throttle({ default: { limit: 10, ttl: HOUR } })
  @HttpCode(200)
  @Post('guest')
  guestCheckout(@Body() dto: GuestCheckoutDto) {
    return this.auth.guestCheckout(dto.phone);
  }

  // ---- Google OAuth ----
  @Public()
  @UseGuards(GoogleAuthGuard)
  @Get('google')
  googleAuth() {
    // Passport redirects to Google; nothing to return.
  }

  @Public()
  @UseGuards(GoogleAuthGuard)
  @Get('google/callback')
  async googleCallback(
    @Req() req: { user: User },
    @Res() res: Response,
  ): Promise<void> {
    const result = await this.auth.googleLogin(req.user);
    const url = new URL(
      '/auth/callback',
      this.config.getOrThrow<string>('FRONTEND_URL'),
    );
    url.searchParams.set('accessToken', result.accessToken);
    url.searchParams.set('refreshToken', result.refreshToken);
    res.redirect(url.toString());
  }

  // ---- RBAC demo: admin-only ----
  @Roles(Role.ADMIN, Role.SUPERADMIN)
  @Get('admin/users')
  listUsers() {
    // list() is already bounded + public-projected (no passwordHash fetched).
    return this.users.list();
  }
}
