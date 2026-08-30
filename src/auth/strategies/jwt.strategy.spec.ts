import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthProvider, Role, User } from '@prisma/client';
import { JwtStrategy } from './jwt.strategy';
import { UsersService } from '../../users/users.service';

function makeUser(over: Partial<User> = {}): User {
  return {
    id: 'u1',
    email: 'a@b.com',
    phone: null,
    passwordHash: null,
    name: 'A',
    googleId: null,
    provider: AuthProvider.LOCAL,
    roles: [Role.USER],
    isActive: true,
    emailVerified: false,
    phoneVerified: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

describe('JwtStrategy', () => {
  let users: jest.Mocked<Pick<UsersService, 'findById'>>;
  let strategy: JwtStrategy;

  beforeEach(() => {
    users = { findById: jest.fn() };
    const config = {
      getOrThrow: () => 'secret',
    } as unknown as ConfigService;
    strategy = new JwtStrategy(config, users as unknown as UsersService);
  });

  const payload = { sub: 'u1', email: 'a@b.com', roles: [Role.USER] };

  it('returns the auth user when the account is active', async () => {
    users.findById.mockResolvedValue(makeUser());
    const result = await strategy.validate(payload);
    expect(result).toEqual({ id: 'u1', email: 'a@b.com', roles: [Role.USER] });
  });

  it('rejects when the account has been deactivated', async () => {
    users.findById.mockResolvedValue(makeUser({ isActive: false }));
    await expect(strategy.validate(payload)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects when the account no longer exists', async () => {
    users.findById.mockResolvedValue(null);
    await expect(strategy.validate(payload)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});
