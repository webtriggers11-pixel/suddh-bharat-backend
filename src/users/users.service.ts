import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, Role, User } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service';

/** Projection used by the admin user list — never fetches passwordHash. */
const ADMIN_USER_SELECT = {
  id: true,
  email: true,
  phone: true,
  name: true,
  roles: true,
  isActive: true,
  provider: true,
  emailVerified: true,
  phoneVerified: true,
  createdAt: true,
} satisfies Prisma.UserSelect;

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

  /**
   * Admin user list with search + pagination (spec 06). Returns a page envelope
   * so the dashboard can drive its pagination bar. Projected (no passwordHash).
   */
  async adminList(params: {
    page?: number;
    pageSize?: number;
    search?: string;
  }) {
    const page = Math.max(params.page ?? 1, 1);
    const pageSize = Math.min(Math.max(params.pageSize ?? 20, 1), 100);
    const search = params.search?.trim();
    const where: Prisma.UserWhereInput = search
      ? {
          OR: [
            { name: { contains: search, mode: 'insensitive' } },
            { email: { contains: search, mode: 'insensitive' } },
            { phone: { contains: search, mode: 'insensitive' } },
          ],
        }
      : {};
    const [data, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: ADMIN_USER_SELECT,
      }),
      this.prisma.user.count({ where }),
    ]);
    return {
      data,
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    };
  }

  /** Create a staff admin account (super-admin action, spec 06). */
  async createAdmin(input: { name: string; email: string; password: string }) {
    const email = input.email.trim().toLowerCase();
    if (await this.findByEmail(email)) {
      throw new ConflictException('Email already registered');
    }
    const user = await this.prisma.user.create({
      data: {
        email,
        name: input.name,
        passwordHash: await bcrypt.hash(input.password, 12),
        roles: [Role.ADMIN],
        emailVerified: true,
      },
      select: ADMIN_USER_SELECT,
    });
    return user;
  }

  /** Toggle a user's active state (super-admin action, spec 06). */
  async setActive(id: string, isActive: boolean) {
    const exists = await this.prisma.user.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!exists) throw new NotFoundException('User not found');
    return this.prisma.user.update({
      where: { id },
      data: { isActive },
      select: ADMIN_USER_SELECT,
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
      isActive: user.isActive,
      provider: user.provider,
      emailVerified: user.emailVerified,
      phoneVerified: user.phoneVerified,
      createdAt: user.createdAt,
    };
  }
}
