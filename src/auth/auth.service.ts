import {
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { AuthProvider, User } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { UsersService } from '../users/users.service';
import { TokenService } from './tokens/token.service';
import { OtpService } from './otp/otp.service';
import { LoginDto, RegisterDto } from './dto/auth.dto';

export interface AuthResult {
  user: ReturnType<typeof UsersService.toPublic>;
  accessToken: string;
  refreshToken: string;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly users: UsersService,
    private readonly tokens: TokenService,
    private readonly otp: OtpService,
  ) {}

  private async withTokens(user: User): Promise<AuthResult> {
    const { accessToken, refreshToken } = await this.tokens.issue(user);
    return { user: UsersService.toPublic(user), accessToken, refreshToken };
  }

  // ---- Email + password --------------------------------------------------

  async register(dto: RegisterDto): Promise<AuthResult> {
    if (await this.users.findByEmail(dto.email)) {
      throw new ConflictException('Email already registered');
    }
    const user = await this.users.create({
      email: dto.email,
      name: dto.name,
      passwordHash: await bcrypt.hash(dto.password, 12),
      provider: AuthProvider.LOCAL,
    });
    return this.withTokens(user);
  }

  async login(dto: LoginDto): Promise<AuthResult> {
    const user = await this.users.findByEmail(dto.email);
    if (!user?.passwordHash) {
      throw new UnauthorizedException('Invalid credentials');
    }
    if (!(await bcrypt.compare(dto.password, user.passwordHash))) {
      throw new UnauthorizedException('Invalid credentials');
    }
    return this.withTokens(user);
  }

  // ---- Refresh / logout --------------------------------------------------

  async refresh(refreshToken: string): Promise<AuthResult> {
    const userId = await this.tokens.consume(refreshToken);
    const user = await this.users.findById(userId);
    if (!user) throw new UnauthorizedException('User no longer exists');
    return this.withTokens(user);
  }

  logout(refreshToken: string): Promise<void> {
    return this.tokens.revoke(refreshToken);
  }

  // ---- Google OAuth ------------------------------------------------------

  async validateGoogleProfile(profile: {
    googleId: string;
    email: string | null;
    name: string | null;
  }): Promise<User> {
    const existing = await this.users.findByGoogleId(profile.googleId);
    if (existing) return existing;

    // Link Google to an existing email account if present.
    if (profile.email) {
      const byEmail = await this.users.findByEmail(profile.email);
      if (byEmail) {
        return this.users.update(byEmail.id, {
          googleId: profile.googleId,
          emailVerified: true,
        });
      }
    }
    return this.users.create({
      googleId: profile.googleId,
      email: profile.email,
      name: profile.name,
      provider: AuthProvider.GOOGLE,
      emailVerified: Boolean(profile.email),
    });
  }

  googleLogin(user: User): Promise<AuthResult> {
    return this.withTokens(user);
  }

  // ---- Phone OTP ---------------------------------------------------------

  async requestOtp(
    phone: string,
  ): Promise<{ phone: string; devCode?: string }> {
    const code = await this.otp.request(phone);
    const dev = process.env.NODE_ENV !== 'production';
    return { phone, ...(dev ? { devCode: code } : {}) };
  }

  async verifyOtp(phone: string, code: string): Promise<AuthResult> {
    if (!(await this.otp.verify(phone, code))) {
      throw new UnauthorizedException('Invalid or expired code');
    }
    const user =
      (await this.users.findByPhone(phone)) ??
      (await this.users.create({
        phone,
        provider: AuthProvider.PHONE,
        phoneVerified: true,
      }));
    return this.withTokens(user);
  }
}
