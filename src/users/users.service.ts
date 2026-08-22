import { ConflictException, Injectable } from '@nestjs/common';
import { Prisma, User } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/** Data access for User accounts. All auth persistence goes through here. */
@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  findById(id: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { id } });
  }

  findByEmail(email: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { email } });
  }

  findByPhone(phone: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { phone } });
  }

  findByGoogleId(googleId: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { googleId } });
  }

  create(data: Prisma.UserCreateInput): Promise<User> {
    return this.prisma.user.create({ data });
  }

  update(id: string, data: Prisma.UserUpdateInput): Promise<User> {
    return this.prisma.user.update({ where: { id }, data });
  }

  /** Update the current user's editable profile fields (name, phone). Phone must
   *  be unique across other users. */
  async updateProfile(
    id: string,
    data: { name?: string; phone?: string },
  ): Promise<User> {
    if (data.phone) {
      const clash = await this.prisma.user.findFirst({
        where: { phone: data.phone, NOT: { id } },
        select: { id: true },
      });
      if (clash) {
        throw new ConflictException('That phone number is already in use');
      }
    }
    return this.prisma.user.update({
      where: { id },
      data: { name: data.name, phone: data.phone },
    });
  }

  /**
   * Admin user list. Bounded + paginated so it never loads the whole user base,
   * and projected so `passwordHash` is never even fetched.
   */
  list(page = 1, pageSize = 50) {
    const take = Math.min(Math.max(pageSize, 1), 100);
    return this.prisma.user.findMany({
      orderBy: { createdAt: 'desc' },
      skip: (Math.max(page, 1) - 1) * take,
      take,
      select: {
        id: true,
        email: true,
        phone: true,
        name: true,
        roles: true,
        provider: true,
        emailVerified: true,
        phoneVerified: true,
        createdAt: true,
      },
    });
  }

  /** Public-safe projection — never leak passwordHash. */
  static toPublic(user: User) {
    return {
      id: user.id,
      email: user.email,
      phone: user.phone,
      name: user.name,
      roles: user.roles,
      provider: user.provider,
      emailVerified: user.emailVerified,
      phoneVerified: user.phoneVerified,
      createdAt: user.createdAt,
    };
  }
}
