import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Role } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

const EMAIL = 'user@example.com';
const PASSWORD = 'password123';
const PHONE = '+919812345678';

describe('Auth (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let http: App;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
    prisma = app.get(PrismaService);
    http = app.getHttpServer();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await prisma.refreshToken.deleteMany();
    await prisma.otpCode.deleteMany();
    await prisma.user.deleteMany();
  });

  const register = () =>
    request(http)
      .post('/auth/register')
      .send({ email: EMAIL, password: PASSWORD, name: 'User' });

  describe('email + password', () => {
    it('registers a user with default USER role and returns tokens', async () => {
      const res = await register().expect(201);
      expect(res.body.user).toMatchObject({ email: EMAIL, roles: ['USER'] });
      expect(res.body.user.passwordHash).toBeUndefined();
      expect(typeof res.body.accessToken).toBe('string');
      expect(typeof res.body.refreshToken).toBe('string');
    });

    it('rejects a duplicate email (409)', async () => {
      await register().expect(201);
      await register().expect(409);
    });

    it('rejects a weak password and unknown fields (400)', async () => {
      await request(http)
        .post('/auth/register')
        .send({ email: EMAIL, password: 'short' })
        .expect(400);
      await request(http)
        .post('/auth/register')
        .send({ email: EMAIL, password: PASSWORD, admin: true })
        .expect(400);
    });

    it('logs in with correct credentials and rejects wrong ones', async () => {
      await register().expect(201);
      await request(http)
        .post('/auth/login')
        .send({ email: EMAIL, password: PASSWORD })
        .expect(200);
      await request(http)
        .post('/auth/login')
        .send({ email: EMAIL, password: 'wrong' })
        .expect(401);
    });
  });

  describe('protected routes + JWT', () => {
    it('returns the profile with a valid token and 401 without one', async () => {
      const { body } = await register().expect(201);
      await request(http)
        .get('/auth/me')
        .set('Authorization', `Bearer ${body.accessToken}`)
        .expect(200)
        .expect((r) => expect(r.body.email).toBe(EMAIL));
      await request(http).get('/auth/me').expect(401);
    });
  });

  describe('refresh token rotation', () => {
    it('rotates on refresh and rejects the consumed token', async () => {
      const { body } = await register().expect(201);
      const first = body.refreshToken;
      const refreshed = await request(http)
        .post('/auth/refresh')
        .send({ refreshToken: first })
        .expect(200);
      expect(refreshed.body.refreshToken).not.toBe(first);
      // old token is now consumed
      await request(http)
        .post('/auth/refresh')
        .send({ refreshToken: first })
        .expect(401);
    });

    it('revokes the refresh token on logout', async () => {
      const { body } = await register().expect(201);
      await request(http)
        .post('/auth/logout')
        .send({ refreshToken: body.refreshToken })
        .expect(200);
      await request(http)
        .post('/auth/refresh')
        .send({ refreshToken: body.refreshToken })
        .expect(401);
    });
  });

  describe('phone OTP', () => {
    it('issues an OTP and logs in / creates the phone user on verify', async () => {
      const req = await request(http)
        .post('/auth/otp/request')
        .send({ phone: PHONE })
        .expect(200);
      const code: string = req.body.devCode;
      expect(code).toMatch(/^\d{6}$/);

      const verified = await request(http)
        .post('/auth/otp/verify')
        .send({ phone: PHONE, code })
        .expect(200);
      expect(verified.body.user).toMatchObject({
        phone: PHONE,
        phoneVerified: true,
        provider: 'PHONE',
      });
    });

    it('rejects a wrong code (401)', async () => {
      await request(http)
        .post('/auth/otp/request')
        .send({ phone: PHONE })
        .expect(200);
      await request(http)
        .post('/auth/otp/verify')
        .send({ phone: PHONE, code: '000000' })
        .expect(401);
    });
  });

  describe('RBAC', () => {
    it('forbids USER and allows ADMIN on the admin route', async () => {
      const { body } = await register().expect(201);
      await request(http)
        .get('/auth/admin/users')
        .set('Authorization', `Bearer ${body.accessToken}`)
        .expect(403);

      // promote to ADMIN, then re-login to get a token carrying the new role
      await prisma.user.update({
        where: { email: EMAIL },
        data: { roles: [Role.ADMIN] },
      });
      const login = await request(http)
        .post('/auth/login')
        .send({ email: EMAIL, password: PASSWORD })
        .expect(200);
      const list = await request(http)
        .get('/auth/admin/users')
        .set('Authorization', `Bearer ${login.body.accessToken}`)
        .expect(200);
      expect(Array.isArray(list.body)).toBe(true);
      expect(list.body[0].email).toBe(EMAIL);
    });
  });
});
