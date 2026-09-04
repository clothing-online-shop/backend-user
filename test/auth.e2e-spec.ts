import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import Redis from 'ioredis';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/config/prisma.service';
import { REDIS_CLIENT } from '../src/config/redis.module';
import { MailService } from '../src/modules/mail/mail.service';
import { AllExceptionsFilter } from '../src/common/filters/http-exception.filter';

interface SentMail {
  method: string;
  args: unknown[];
}

interface LoginResponse {
  accessToken: string;
  refreshToken: string;
}

interface ErrorResponse {
  error: string;
}

describe('Auth (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let redis: Redis;
  const sent: SentMail[] = [];
  const tag = `auth-e2e-${Date.now()}`;
  const email = `${tag}@example.com`;
  const createdEmails: string[] = [];

  const fakeMail: Partial<Record<keyof MailService, jest.Mock>> = {
    sendOtpEmail: jest.fn((...args) =>
      sent.push({ method: 'sendOtpEmail', args }),
    ),
    sendWelcomeEmail: jest.fn((...args) =>
      sent.push({ method: 'sendWelcomeEmail', args }),
    ),
    sendPasswordResetEmail: jest.fn((...args) =>
      sent.push({ method: 'sendPasswordResetEmail', args }),
    ),
    sendPasswordChangedEmail: jest.fn((...args) =>
      sent.push({ method: 'sendPasswordChangedEmail', args }),
    ),
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(MailService)
      .useValue(fakeMail)
      .compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        transform: true,
        forbidNonWhitelisted: true,
      }),
    );
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();

    prisma = moduleFixture.get(PrismaService);
    redis = moduleFixture.get(REDIS_CLIENT);

    // Stale throttler keys from a prior run or a parallel throttle spec can cause
    // spurious 429s — start from a clean slate.
    await flushThrottleKeys();
  });

  // @nest-lab/throttler-storage-redis writes `{<hash>:<name>}:hits` / `:blocked`
  // keys (no "throttle" prefix); also sweep the `throttle*` shape for safety.
  async function flushThrottleKeys(): Promise<void> {
    const keys = [
      ...(await redis.keys('throttle*')),
      ...(await redis.keys('{*}:hits')),
      ...(await redis.keys('{*}:blocked')),
    ];
    if (keys.length) await redis.del(...keys);
  }

  afterAll(async () => {
    if (createdEmails.length) {
      await prisma.user.deleteMany({ where: { email: { in: createdEmails } } });
    }
    for (const e of createdEmails) {
      await redis.del(`otp:register:${e}`, `otp-resend:register:${e}`);
    }
    // Best-effort cleanup of the reset-flow keys this run created (they also expire).
    const resetKeys = [
      ...(await redis.keys('pwd-reset-jti:*')),
      ...(await redis.keys('pwd-reset-cooldown:*')),
    ];
    if (resetKeys.length) await redis.del(...resetKeys);
    await flushThrottleKeys();
    await app.close();
  });

  async function readOtp(forEmail: string): Promise<string> {
    const raw = await redis.get(`otp:register:${forEmail}`);
    if (!raw) throw new Error('OTP not found in Redis');
    return (JSON.parse(raw) as { code: string }).code;
  }

  it('register -> verify-otp -> login happy path', async () => {
    createdEmails.push(email);

    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password: 'password1', fullName: 'Auth E2E' })
      .expect(201);

    const code = await readOtp(email);

    await request(app.getHttpServer())
      .post('/auth/verify-otp')
      .send({ email, code })
      .expect(200);

    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ identifier: email, password: 'password1' })
      .expect(200);

    const body = res.body as LoginResponse;
    expect(body.accessToken).toBeDefined();
    expect(body.refreshToken).toBeDefined();
  });

  it('login before verification returns 403 EMAIL_NOT_VERIFIED', async () => {
    const e2 = `${tag}-unverified@example.com`;
    createdEmails.push(e2);

    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email: e2, password: 'password1', fullName: 'Unverified' })
      .expect(201);

    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ identifier: e2, password: 'password1' })
      .expect(403);

    const body = res.body as ErrorResponse;
    expect(body.error).toBe('EMAIL_NOT_VERIFIED');
  });

  it('forgot-password -> reset-password -> login with new password; token cannot be reused', async () => {
    // uses the verified account from the first test
    await request(app.getHttpServer())
      .post('/auth/forgot-password')
      .send({ email })
      .expect(200);

    const resetCall = [...sent]
      .reverse()
      .find((m) => m.method === 'sendPasswordResetEmail');
    expect(resetCall).toBeDefined();
    const link = resetCall!.args[1] as string;
    const token = new URL(link).searchParams.get('token')!;
    expect(token).toBeTruthy();

    await request(app.getHttpServer())
      .post('/auth/reset-password')
      .send({ token, newPassword: 'password2' })
      .expect(200);

    await request(app.getHttpServer())
      .post('/auth/login')
      .send({ identifier: email, password: 'password2' })
      .expect(200);

    // reuse -> 400
    await request(app.getHttpServer())
      .post('/auth/reset-password')
      .send({ token, newPassword: 'password3' })
      .expect(400);

    const changed = sent.some((m) => m.method === 'sendPasswordChangedEmail');
    expect(changed).toBe(true);
  });

  it('forgot-password is silent for an unknown email', async () => {
    await request(app.getHttpServer())
      .post('/auth/forgot-password')
      .send({ email: `${tag}-nobody@example.com` })
      .expect(200);
  });
});
