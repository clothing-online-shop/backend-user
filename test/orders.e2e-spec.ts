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

interface CreateOrderResponse {
  id: string;
  status: string;
  orderCode: string;
  totalAmount: number;
  items: Array<{
    productVariantId: string;
    productName: string;
    size: string;
    color: string;
    quantity: number;
    priceAtPurchase: number;
  }>;
}

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
  let createdOrderCode: string;

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
      data: {
        ghnCode: `WARD-TEST-${ghnSeed}`,
        districtId: district.id,
        name: 'Xã Test',
      },
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
    // Guard: các biến id trên chỉ được gán tuần tự khi từng bước seed trong beforeAll
    // thành công. Nếu beforeAll throw giữa chừng (ví dụ lỗi tràn số Int4, lỗi DB tạm
    // thời, hoặc va unique constraint từ lần chạy song song khác), những biến gán SAU
    // điểm lỗi vẫn là undefined. Prisma loại bỏ key có giá trị undefined khỏi `where`
    // thay vì coi là "không khớp gì", nên deleteMany({ where: { id: undefined } }) sẽ
    // xoá KHÔNG GIỚI HẠN toàn bộ bảng. Mỗi lệnh xoá dưới đây vì vậy phải được bọc trong
    // guard kiểm tra id tương ứng đã được gán hay chưa trước khi chạy.
    if (userId) {
      await prisma.orderStatusHistory.deleteMany({
        where: { order: { userId } },
      });
      await prisma.orderItem.deleteMany({ where: { order: { userId } } });
      await prisma.order.deleteMany({ where: { userId } });
    }
    if (variantId) {
      await prisma.stockMovement.deleteMany({
        where: { productVariantId: variantId },
      });
    }
    if (cartId) {
      await prisma.cartItem.deleteMany({ where: { cartId } });
      await prisma.cart.deleteMany({ where: { id: cartId } });
    }
    if (variantId) {
      await prisma.productVariant.deleteMany({ where: { id: variantId } });
    }
    if (productId) {
      await prisma.product.deleteMany({ where: { id: productId } });
    }
    if (categoryId) {
      await prisma.category.deleteMany({ where: { id: categoryId } });
    }
    if (addressId) {
      await prisma.address.deleteMany({ where: { id: addressId } });
    }
    if (provinceId) {
      // Province -> District -> Ward đều khai onDelete: Cascade (xem schema.prisma) — xoá
      // Province là đủ dọn sạch cả District/Ward vừa tạo cho test này, không cần xoá riêng.
      await prisma.province.deleteMany({ where: { id: provinceId } });
    }
    if (userId) {
      await prisma.user.deleteMany({ where: { id: userId } });
    }
    if (app) {
      await app.close();
    }
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

    const body = response.body as CreateOrderResponse;

    expect(body.status).toBe('PENDING');
    expect(body.orderCode).toMatch(/^DH\d{8}[A-Z0-9]{6}$/);
    // Prisma.Decimal.toJSON() trả string qua JSON.stringify mặc định — assert type number rõ
    // ràng ở đây để bắt hồi quy nếu service quên map .toNumber() trước khi trả response HTTP.
    expect(typeof body.totalAmount).toBe('number');
    expect(body.totalAmount).toBe(300000);
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({
      productVariantId: variantId,
      productName: 'Áo thun E2E',
      size: 'M',
      color: 'Đen',
      quantity: 2,
    });
    expect(typeof body.items[0].priceAtPurchase).toBe('number');
    expect(body.items[0].priceAtPurchase).toBe(150000);

    const orderId = body.id;
    createdOrderCode = body.orderCode;

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

  it('GET /orders/:orderCode — trả đúng dữ liệu đơn vừa tạo', async () => {
    const response = await request(app.getHttpServer())
      .get(`/orders/${createdOrderCode}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const body = response.body as CreateOrderResponse;
    expect(body.orderCode).toBe(createdOrderCode);
    expect(body.status).toBe('PENDING');
    expect(typeof body.totalAmount).toBe('number');
    expect(body.totalAmount).toBe(300000);
    expect(body.items).toHaveLength(1);
  });

  it('GET /orders/:orderCode — orderCode không tồn tại → 404', async () => {
    await request(app.getHttpServer())
      .get('/orders/DH-KHONG-TON-TAI')
      .set('Authorization', `Bearer ${token}`)
      .expect(404);
  });
});
