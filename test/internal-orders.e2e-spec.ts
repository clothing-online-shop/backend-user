import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/config/prisma.service';
import { AllExceptionsFilter } from '../src/common/filters/http-exception.filter';
import { UserRole } from '@prisma/client';

// Order.shippingAddress là string thuần (không phải FK tới Address) nên fixture ở đây chỉ
// cần User + Order, không cần dựng lại Cart/Product/Address như orders.e2e-spec.ts (test đó
// test đúng luồng tạo đơn thật, cần đủ chuỗi FK — test này chỉ test 1 endpoint đọc lại đơn có
// sẵn để gửi email).
describe('Internal orders (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let userId: string;
  let orderId: string;
  let orderCode: string;
  const internalKey = 'test-internal-notify-key';

  beforeAll(async () => {
    process.env.INTERNAL_NOTIFY_KEY = internalKey;

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

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

    const user = await prisma.user.create({
      data: {
        email: `internal-orders-e2e-${Date.now()}@example.com`,
        password: 'unused-hash',
        fullName: 'Internal Orders E2E User',
        role: UserRole.CUSTOMER,
      },
    });
    userId = user.id;

    orderCode = `DH-INTERNAL-E2E-${Date.now()}`;
    const order = await prisma.order.create({
      data: {
        userId,
        orderCode,
        status: 'CONFIRMED',
        totalAmount: '150000',
        shippingAddress: 'Nguyễn Văn Test - 0900000000 - 1 Đường Test',
        paymentMethod: 'COD',
      },
    });
    orderId = order.id;
  });

  afterAll(async () => {
    if (orderId) {
      await prisma.order.deleteMany({ where: { id: orderId } });
    }
    if (userId) {
      await prisma.user.deleteMany({ where: { id: userId } });
    }
    if (app) {
      await app.close();
    }
  });

  it('POST /internal/orders/:orderCode/status-notification — thiếu header x-internal-key → 401', async () => {
    await request(app.getHttpServer())
      .post(`/internal/orders/${orderCode}/status-notification`)
      .send({ status: 'PACKING' })
      .expect(401);
  });

  it('POST /internal/orders/:orderCode/status-notification — sai key → 401', async () => {
    await request(app.getHttpServer())
      .post(`/internal/orders/${orderCode}/status-notification`)
      .set('x-internal-key', 'wrong-key')
      .send({ status: 'PACKING' })
      .expect(401);
  });

  it('POST /internal/orders/:orderCode/status-notification — orderCode không tồn tại → 404', async () => {
    await request(app.getHttpServer())
      .post('/internal/orders/khong-ton-tai/status-notification')
      .set('x-internal-key', internalKey)
      .send({ status: 'PACKING' })
      .expect(404);
  });

  it('POST /internal/orders/:orderCode/status-notification — đúng key + orderCode hợp lệ → 201', async () => {
    await request(app.getHttpServer())
      .post(`/internal/orders/${orderCode}/status-notification`)
      .set('x-internal-key', internalKey)
      .send({ status: 'PACKING', note: null })
      .expect(201);
  });

  it('POST /internal/orders/:orderCode/status-notification — kèm note (CANCELLED) → 201', async () => {
    await request(app.getHttpServer())
      .post(`/internal/orders/${orderCode}/status-notification`)
      .set('x-internal-key', internalKey)
      .send({ status: 'CANCELLED', note: 'Khách đổi ý' })
      .expect(201);
  });
});
