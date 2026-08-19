import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Role, User } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../../prisma/prisma.service';

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

export interface AccessPayload {
  sub: string;
  email: string | null;
  roles: Role[];
}

/** Duration string ("900s", "30d") → milliseconds. */
function durationMs(value: string): number {
  const m = /^(\d+)\s*([smhd])?$/.exec(value.trim());
  if (!m) return Number(value) * 1000;
  const n = Number(m[1]);
  const unit = m[2] ?? 's';
  return n * { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit]!;
}

@Injectable()
export class TokenService {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  /** Issue an access JWT + a new rotating refresh token (stored hashed). */
  async issue(user: Pick<User, 'id' | 'email' | 'roles'>): Promise<TokenPair> {
    const payload: AccessPayload = {
      sub: user.id,
      email: user.email,
      roles: user.roles,
    };
    const accessTtl = this.config.get<string>('JWT_ACCESS_TTL', '900s');
    const accessToken = await this.jwt.signAsync(payload, {
      secret: this.config.getOrThrow<string>('JWT_ACCESS_SECRET'),
      expiresIn: Math.floor(durationMs(accessTtl) / 1000), // seconds
    });

    const raw = randomBytes(32).toString('hex');
    const tokenHash = await bcrypt.hash(raw, 10);
    const ttl = this.config.get<string>('JWT_REFRESH_TTL', '30d');
    const expiresAt = new Date(Date.now() + durationMs(ttl));
    const row = await this.prisma.refreshToken.create({
      data: { userId: user.id, tokenHash, expiresAt },
    });

    // Composite "selector.verifier": id locates the row, raw proves ownership.
    return { accessToken, refreshToken: `${row.id}.${raw}` };
  }

  private async validate(refreshToken: string) {
    const [id, raw] = refreshToken.split('.');
    if (!id || !raw) throw new UnauthorizedException('Malformed refresh token');
    const row = await this.prisma.refreshToken.findUnique({ where: { id } });
    if (!row || row.revokedAt || row.expiresAt < new Date()) {
      throw new UnauthorizedException('Refresh token invalid or expired');
    }
    if (!(await bcrypt.compare(raw, row.tokenHash))) {
      throw new UnauthorizedException('Refresh token invalid');
    }
    return row;
  }

  /** Single-use: validate + revoke the token, returning its userId (rotation).
   * The revoke is atomic (updateMany guarded on revokedAt: null) so two
   * concurrent refreshes can't both mint a new pair from one token. */
  async consume(refreshToken: string): Promise<string> {
    const row = await this.validate(refreshToken);
    const { count } = await this.prisma.refreshToken.updateMany({
      where: { id: row.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (count !== 1) {
      throw new UnauthorizedException('Refresh token already used');
    }
    return row.userId;
  }

  /** Revoke a refresh token (logout). Silent if already invalid. */
  async revoke(refreshToken: string): Promise<void> {
    try {
      const row = await this.validate(refreshToken);
      await this.prisma.refreshToken.update({
        where: { id: row.id },
        data: { revokedAt: new Date() },
      });
    } catch {
      // logout is idempotent — nothing to revoke
    }
  }
}
