import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/config/prisma.service';
import { AllExceptionsFilter } from '../src/common/filters/http-exception.filter';
import type { JwtPayload } from '../src/modules/auth/strategies/jwt.strategy';
import { UserRole } from '@prisma/client';

describe('Orders (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let jwt: JwtService;

  let userId: string;
  let addressId: string;
  let provinceId: string;
  let categoryId: string;
  let productId: string;
  let variantId: string;
  let cartId: string;
  let cartItemId: string;
  let token: string;

  beforeAll(async () => {
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
    jwt = moduleFixture.get(JwtService);

    const user = await prisma.user.create({
      data: {
        email: `orders-e2e-${Date.now()}@example.com`,
        password: 'unused-hash',
        fullName: 'Orders E2E User',
        role: UserRole.CUSTOMER,
      },
    });
    userId = user.id;
    token = jwt.sign({
      sub: user.id,
      email: user.email,
      role: user.role,
    } satisfies JwtPayload);

    // ghnId/ghnCode phải unique nhưng không cần khớp dữ liệu GHN thật cho e2e — dùng
    // mốc thời gian để không đụng dữ liệu seed thật và không tự đụng chính nó nếu lần
    // chạy trước bị crash giữa chừng trước khi afterAll dọn xong. Lưu ý: ghnId là Postgres
    // Int4 (tối đa 2147483647) nên phải dùng giây (không phải mili giây) kể từ epoch —
    // Date.now() theo mili giây (~1.7 nghìn tỷ hiện nay) tràn số và khiến insert lỗi.
    const ghnSeed = Math.floor(Date.now() / 1000);
    const province = await prisma.province.create({
      data: { ghnId: ghnSeed, name: 'Tỉnh Test' },
    });
    provinceId = province.id;
    const district = await prisma.district.create({
      data: { ghnId: ghnSeed + 1, provinceId: province.id, name: 'Huyện Test' },
    });
    const ward = await prisma.ward.create({
      data: { ghnCode: `WARD-TEST-${ghnSeed}`, districtId: district.id, name: 'Xã Test' },
    });
    const addr = await prisma.address.create({
      data: {
        userId,
        receiverName: 'Nguyễn Văn Test',
        phone: '0900000001',
        provinceId: province.id,
        districtId: district.id,
        wardId: ward.id,
        detail: '1 Đường Test',
        isDefault: true,
      },
    });
    addressId = addr.id;

    const category = await prisma.category.create({
      data: { name: 'Category E2E', slug: `category-e2e-${Date.now()}` },
    });
    categoryId = category.id;
    const product = await prisma.product.create({
      data: {
        name: 'Áo thun E2E',
        slug: `ao-thun-e2e-${Date.now()}`,
        categoryId,
        basePrice: '150000',
        status: 1, // ProductStatus.ACTIVE
      },
    });
    productId = product.id;
    const variant = await prisma.productVariant.create({
      data: {
        productId,
        size: 'M',
        color: 'Đen',
        sku: `SKU-E2E-${Date.now()}`,
        price: '150000',
        stockQuantity: 10,
      },
    });
    variantId = variant.id;

    const cart = await prisma.cart.create({ data: { userId } });
    cartId = cart.id;
    const item = await prisma.cartItem.create({
      data: { cartId, productVariantId: variantId, quantity: 2 },
    });
    cartItemId = item.id;
  });

  afterAll(async () => {
    await prisma.orderStatusHistory.deleteMany({ where: { order: { userId } } });
    await prisma.orderItem.deleteMany({ where: { order: { userId } } });
    await prisma.order.deleteMany({ where: { userId } });
    await prisma.stockMovement.deleteMany({ where: { productVariantId: variantId } });
    await prisma.cartItem.deleteMany({ where: { cartId } });
    await prisma.cart.deleteMany({ where: { id: cartId } });
    await prisma.productVariant.deleteMany({ where: { id: variantId } });
    await prisma.product.deleteMany({ where: { id: productId } });
    await prisma.category.deleteMany({ where: { id: categoryId } });
    await prisma.address.deleteMany({ where: { id: addressId } });
    // Province -> District -> Ward đều khai onDelete: Cascade (xem schema.prisma) — xoá
    // Province là đủ dọn sạch cả District/Ward vừa tạo cho test này, không cần xoá riêng.
    await prisma.province.deleteMany({ where: { id: provinceId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await app.close();
  });

  it('POST /orders — tạo đơn thành công: trừ kho, ghi lịch sử, xoá cart item', async () => {
    const response = await request(app.getHttpServer())
      .post('/orders')
      .set('Authorization', `Bearer ${token}`)
      .send({
        addressId,
        cartItemIds: [cartItemId],
        paymentMethod: 'COD',
      })
      .expect(201);

    expect(response.body.status).toBe('PENDING');
    expect(response.body.orderCode).toMatch(/^DH\d{8}[A-Z0-9]{6}$/);
    expect(response.body.items).toHaveLength(1);
    expect(response.body.items[0]).toMatchObject({
      productVariantId: variantId,
      productName: 'Áo thun E2E',
      size: 'M',
      color: 'Đen',
      quantity: 2,
    });

    const orderId = response.body.id as string;

    const variant = await prisma.productVariant.findUniqueOrThrow({
      where: { id: variantId },
    });
    expect(variant.stockQuantity).toBe(8);

    const movements = await prisma.stockMovement.findMany({
      where: { productVariantId: variantId },
    });
    expect(movements).toHaveLength(1);
    expect(movements[0].quantity).toBe(-2);

    const history = await prisma.orderStatusHistory.findMany({
      where: { orderId },
    });
    expect(history).toHaveLength(1);
    expect(history[0].toStatus).toBe('PENDING');
    expect(history[0].fromStatus).toBeNull();

    const remainingCartItem = await prisma.cartItem.findUnique({
      where: { id: cartItemId },
    });
    expect(remainingCartItem).toBeNull();
  });

  it('POST /orders — gọi lại với cartItemId đã bị xoá khỏi giỏ → 404', async () => {
    await request(app.getHttpServer())
      .post('/orders')
      .set('Authorization', `Bearer ${token}`)
      .send({
        addressId,
        cartItemIds: [cartItemId],
        paymentMethod: 'COD',
      })
      .expect(404);
  });
});
