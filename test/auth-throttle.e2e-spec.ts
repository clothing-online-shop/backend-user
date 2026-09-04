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

describe('Auth throttling (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let redis: Redis;

  const fakeMail: Partial<Record<keyof MailService, jest.Mock>> = {
    sendOtpEmail: jest.fn(),
    sendWelcomeEmail: jest.fn(),
  };

  // @nest-lab/throttler-storage-redis writes `{<hash>:<name>}:hits` / `:blocked`
  // keys (brace chars are literal in Redis globs, and there is no "throttle"
  // prefix); also sweep the `throttle*` shape for safety.
  async function flushThrottleKeys(): Promise<void> {
    const keys = [
      ...(await redis.keys('throttle*')),
      ...(await redis.keys('{*}:hits')),
      ...(await redis.keys('{*}:blocked')),
    ];
    if (keys.length) await redis.del(...keys);
  }

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

  afterAll(async () => {
    await flushThrottleKeys();
    await prisma.user.deleteMany({
      where: { email: { contains: 'throttle-' } },
    });
    await app.close();
  });

  it('returns 429 after exceeding the register limit (5 / 10 min)', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) {
      const res = await request(app.getHttpServer())
        .post('/auth/register')
        .send({
          email: `throttle-${Date.now()}-${i}@example.com`,
          password: 'password1',
          fullName: 'Throttle Test',
        });
      statuses.push(res.status);
    }

    expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);
    expect(statuses[statuses.length - 1]).toBe(429);
  });
});
