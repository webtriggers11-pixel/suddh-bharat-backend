import { ConflictException, UnauthorizedException } from '@nestjs/common';
import { AuthProvider, Role, User } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { AuthService } from './auth.service';
import { UsersService } from '../users/users.service';
import { TokenService } from './tokens/token.service';
import { OtpService } from './otp/otp.service';

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

describe('AuthService', () => {
  let users: jest.Mocked<
    Pick<
      UsersService,
      | 'findByEmail'
      | 'findByPhone'
      | 'findById'
      | 'findByGoogleId'
      | 'create'
      | 'update'
    >
  >;
  let tokens: jest.Mocked<Pick<TokenService, 'issue' | 'consume' | 'revoke'>>;
  let otp: jest.Mocked<Pick<OtpService, 'request' | 'verify'>>;
  let service: AuthService;

  beforeEach(() => {
    users = {
      findByEmail: jest.fn(),
      findByPhone: jest.fn(),
      findById: jest.fn(),
      findByGoogleId: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    };
    tokens = {
      issue: jest
        .fn()
        .mockResolvedValue({ accessToken: 'at', refreshToken: 'rt' }),
      consume: jest.fn(),
      revoke: jest.fn(),
    };
    otp = { request: jest.fn(), verify: jest.fn() };
    service = new AuthService(
      users as unknown as UsersService,
      tokens as unknown as TokenService,
      otp as unknown as OtpService,
    );
  });

  it('register rejects a duplicate email', async () => {
    users.findByEmail.mockResolvedValue(makeUser());
    await expect(
      service.register({ email: 'a@b.com', password: 'password123' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('register hashes the password and issues tokens', async () => {
    users.findByEmail.mockResolvedValue(null);
    users.create.mockImplementation(async (d) =>
      makeUser({ passwordHash: d.passwordHash as string }),
    );
    const res = await service.register({
      email: 'a@b.com',
      password: 'password123',
    });
    expect(res.accessToken).toBe('at');
    const created = users.create.mock.calls[0][0];
    expect(created.passwordHash).not.toBe('password123'); // hashed
    expect(
      await bcrypt.compare('password123', created.passwordHash as string),
    ).toBe(true);
  });

  it('login rejects a wrong password', async () => {
    users.findByEmail.mockResolvedValue(
      makeUser({ passwordHash: await bcrypt.hash('correct', 10) }),
    );
    await expect(
      service.login({ email: 'a@b.com', password: 'wrong' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('login succeeds with the right password', async () => {
    users.findByEmail.mockResolvedValue(
      makeUser({ passwordHash: await bcrypt.hash('correct', 10) }),
    );
    const res = await service.login({ email: 'a@b.com', password: 'correct' });
    expect(res.refreshToken).toBe('rt');
  });

  it('verifyOtp creates a new user when the phone is unknown', async () => {
    otp.verify.mockResolvedValue(true);
    users.findByPhone.mockResolvedValue(null);
    users.create.mockResolvedValue(
      makeUser({ phone: '+91981', provider: AuthProvider.PHONE }),
    );
    const res = await service.verifyOtp('+91981', '123456');
    expect(users.create).toHaveBeenCalled();
    expect(res.accessToken).toBe('at');
  });

  it('verifyOtp rejects a bad code', async () => {
    otp.verify.mockResolvedValue(false);
    await expect(service.verifyOtp('+91981', '000000')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('login rejects a deactivated account even with the right password', async () => {
    users.findByEmail.mockResolvedValue(
      makeUser({
        isActive: false,
        passwordHash: await bcrypt.hash('correct', 10),
      }),
    );
    await expect(
      service.login({ email: 'a@b.com', password: 'correct' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(tokens.issue).not.toHaveBeenCalled();
  });

  it('refresh rejects a deactivated account', async () => {
    tokens.consume.mockResolvedValue('u1');
    users.findById.mockResolvedValue(makeUser({ isActive: false }));
    await expect(service.refresh('rt')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(tokens.issue).not.toHaveBeenCalled();
  });

  it('googleLogin rejects a deactivated account', async () => {
    await expect(
      service.googleLogin(makeUser({ isActive: false })),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(tokens.issue).not.toHaveBeenCalled();
  });

  it('validateGoogleProfile links an existing email account', async () => {
    users.findByGoogleId.mockResolvedValue(null);
    users.findByEmail.mockResolvedValue(makeUser({ id: 'existing' }));
    users.update.mockResolvedValue(
      makeUser({ id: 'existing', googleId: 'g1' }),
    );
    const user = await service.validateGoogleProfile({
      googleId: 'g1',
      email: 'a@b.com',
      name: 'A',
    });
    expect(users.update).toHaveBeenCalledWith('existing', {
      googleId: 'g1',
      emailVerified: true,
    });
    expect(user.id).toBe('existing');
  });

  it('guestCheckout creates a brand-new unverified user for an unknown phone', async () => {
    users.findByPhone.mockResolvedValue(null);
    users.create.mockResolvedValue(
      makeUser({
        phone: '+91981',
        provider: AuthProvider.PHONE,
        phoneVerified: false,
      }),
    );
    const res = await service.guestCheckout('+91981');
    expect(users.create).toHaveBeenCalledWith({
      phone: '+91981',
      provider: AuthProvider.PHONE,
      phoneVerified: false,
    });
    expect(res.accessToken).toBe('at');
  });

  it('guestCheckout rejects a phone that already has an account — never logs into an existing account without verification', async () => {
    users.findByPhone.mockResolvedValue(makeUser({ phone: '+91981' }));
    await expect(service.guestCheckout('+91981')).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(users.create).not.toHaveBeenCalled();
  });
});
