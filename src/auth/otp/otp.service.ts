import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomInt } from 'node:crypto';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../../prisma/prisma.service';

const MAX_ATTEMPTS = 5;

@Injectable()
export class OtpService {
  private readonly logger = new Logger(OtpService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Generate + store a hashed OTP for a phone and "send" it. Returns the raw
   * code so the caller can surface it in non-production (real SMS provider TODO).
   */
  async request(phone: string, purpose = 'LOGIN'): Promise<string> {
    const length = this.config.get<number>('OTP_LENGTH', 6);
    const ttl = this.config.get<number>('OTP_TTL_SECONDS', 300);
    const code = String(randomInt(0, 10 ** length)).padStart(length, '0');

    // Invalidate any prior unconsumed codes so only the newest is valid — shrinks
    // the guessing window (a fresh request must not leave old codes live).
    await this.prisma.otpCode.updateMany({
      where: { phone, purpose, consumedAt: null },
      data: { consumedAt: new Date() },
    });

    await this.prisma.otpCode.create({
      data: {
        phone,
        purpose,
        codeHash: await bcrypt.hash(code, 10),
        expiresAt: new Date(Date.now() + ttl * 1000),
      },
    });

    // TODO: real SMS provider (MSG91). The code is NEVER logged in the clear —
    // only surfaced behind an explicit OTP_DEBUG flag for local development.
    if (this.config.get<string>('OTP_DEBUG') === 'true') {
      this.logger.debug(`OTP for ${phone}: ${code}`);
    }
    return code;
  }

  /** Verify the latest live OTP for a phone; consumes it on success. */
  async verify(
    phone: string,
    code: string,
    purpose = 'LOGIN',
  ): Promise<boolean> {
    const otp = await this.prisma.otpCode.findFirst({
      where: {
        phone,
        purpose,
        consumedAt: null,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (!otp || otp.attempts >= MAX_ATTEMPTS) return false;

    const ok = await bcrypt.compare(code, otp.codeHash);
    await this.prisma.otpCode.update({
      where: { id: otp.id },
      data: ok ? { consumedAt: new Date() } : { attempts: { increment: 1 } },
    });
    return ok;
  }
}
