import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import * as argon2 from 'argon2';
import { AppModule } from './../src/app.module';
import { PrismaService } from './../src/config/prisma.service';

interface LoginResponseBody {
  accessToken: string;
}
interface AddressResponseBody {
  id: string;
}
interface CartResponseBody {
  items: { id: string }[];
}
interface OrderResponseBody {
  id: string;
  orderCode: string;
  totalAmount: number;
  items: unknown[];
}
interface BankTransferResponseBody {
  transferContent: string;
  amount: number;
}

// Luồng chính chuyển khoản (không phụ thuộc VNPay thật — cần sandbox thật mới e2e được,
// xem vnpay-signature.util.spec.ts/payments.service.spec.ts cho phần VNPay): đăng nhập →
// thêm giỏ hàng → tạo địa chỉ → tạo đơn → khởi tạo chuyển khoản → assert trạng thái đơn.
describe('Orders + Payments (bank transfer happy path, e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  const ids = {
    userId: '',
    categoryId: '',
    productId: '',
    variantId: '',
    provinceId: '',
    districtId: '',
    wardId: '',
    addressId: '',
    orderId: '',
  };
  const userEmail = `e2e-order-${Date.now()}@example.com`;
  const userPassword = 'Test1234!';
  let accessToken: string;

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
    await app.init();
    prisma = moduleFixture.get(PrismaService);

    const passwordHash = await argon2.hash(userPassword);
    const user = await prisma.user.create({
      data: {
        email: userEmail,
        password: passwordHash,
        fullName: 'E2E Order Test',
        emailVerifiedAt: new Date(),
      },
    });
    ids.userId = user.id;

    const category = await prisma.category.create({
      data: { name: 'E2E Category', slug: `e2e-category-${Date.now()}` },
    });
    ids.categoryId = category.id;

    const product = await prisma.product.create({
      data: {
        name: 'E2E Product',
        slug: `e2e-product-${Date.now()}`,
        categoryId: category.id,
        basePrice: 100000,
        status: 1, // ProductStatus.ACTIVE
      },
    });
    ids.productId = product.id;

    const variant = await prisma.productVariant.create({
      data: {
        productId: product.id,
        size: 'M',
        color: 'Đen',
        sku: `E2E-SKU-${Date.now()}`,
        price: 100000,
        stockQuantity: 10,
      },
    });
    ids.variantId = variant.id;

    // ghnId là INT4 (32-bit) ở DB — không dùng thẳng Date.now() (13 chữ số, tràn số), rút
    // về giây (~10 chữ số, vẫn nằm dưới giới hạn INT4 ~2.1 tỷ ở thời điểm hiện tại).
    const ghnSeed = Math.floor(Date.now() / 1000);
    const province = await prisma.province.create({
      data: { name: 'E2E Tỉnh', ghnId: ghnSeed },
    });
    ids.provinceId = province.id;
    const district = await prisma.district.create({
      data: { name: 'E2E Huyện', ghnId: ghnSeed + 1, provinceId: province.id },
    });
    ids.districtId = district.id;
    const ward = await prisma.ward.create({
      data: {
        name: 'E2E Xã',
        ghnCode: String(ghnSeed + 2),
        districtId: district.id,
      },
    });
    ids.wardId = ward.id;

    const loginRes = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ identifier: userEmail, password: userPassword })
      .expect(200);
    accessToken = (loginRes.body as LoginResponseBody).accessToken;
  });

  afterAll(async () => {
    await prisma.paymentTransaction.deleteMany({
      where: { order: { userId: ids.userId } },
    });
    await prisma.orderItem.deleteMany({
      where: { order: { userId: ids.userId } },
    });
    await prisma.order.deleteMany({ where: { userId: ids.userId } });
    await prisma.cartItem.deleteMany({
      where: { cart: { userId: ids.userId } },
    });
    await prisma.cart.deleteMany({ where: { userId: ids.userId } });
    await prisma.address.deleteMany({ where: { userId: ids.userId } });
    // stock_movements.productVariantId là FK Restrict (không Cascade) — phải xóa lịch sử
    // kho trước, không thì xóa ProductVariant sẽ bị Postgres chặn (đúng chủ đích: biến thể
    // đã có lịch sử kho không được xóa cứng ngoài đời thật, xem comment trong schema.prisma).
    await prisma.stockMovement.deleteMany({
      where: { productVariantId: ids.variantId },
    });
    await prisma.productVariant.deleteMany({ where: { id: ids.variantId } });
    await prisma.product.deleteMany({ where: { id: ids.productId } });
    await prisma.category.deleteMany({ where: { id: ids.categoryId } });
    await prisma.ward.deleteMany({ where: { id: ids.wardId } });
    await prisma.district.deleteMany({ where: { id: ids.districtId } });
    await prisma.province.deleteMany({ where: { id: ids.provinceId } });
    await prisma.user.deleteMany({ where: { id: ids.userId } });
    await app.close();
  });

  it('thêm giỏ hàng, tạo địa chỉ, tạo đơn, khởi tạo chuyển khoản', async () => {
    const cartRes = await request(app.getHttpServer())
      .post('/cart/items')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ productVariantId: ids.variantId, quantity: 2 })
      .expect(201);
    const cartItemId = (cartRes.body as CartResponseBody).items[0].id;

    const addressRes = await request(app.getHttpServer())
      .post('/addresses')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        receiverName: 'Nguyễn Văn A',
        phone: '0900000000',
        provinceId: ids.provinceId,
        districtId: ids.districtId,
        wardId: ids.wardId,
        detail: '123 Đường ABC',
      })
      .expect(201);
    ids.addressId = (addressRes.body as AddressResponseBody).id;

    const orderRes = await request(app.getHttpServer())
      .post('/orders')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        addressId: ids.addressId,
        cartItemIds: [cartItemId],
        paymentMethod: 'BANK_TRANSFER',
      })
      .expect(201);
    const orderBody = orderRes.body as OrderResponseBody;
    ids.orderId = orderBody.id;
    expect(orderBody.totalAmount).toBe(200000);
    expect(orderBody.items).toHaveLength(1);

    const variantAfter = await prisma.productVariant.findUnique({
      where: { id: ids.variantId },
    });
    expect(variantAfter?.stockQuantity).toBe(8);

    const bankTransferRes = await request(app.getHttpServer())
      .post(`/payments/${ids.orderId}/bank-transfer`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({})
      .expect(201);
    const bankTransferBody = bankTransferRes.body as BankTransferResponseBody;
    expect(bankTransferBody.transferContent).toBe(orderBody.orderCode);
    expect(bankTransferBody.amount).toBe(200000);

    const orderAfter = await prisma.order.findUnique({
      where: { id: ids.orderId },
    });
    expect(orderAfter?.paymentStatus).toBe('UNPAID');
    expect(orderAfter?.paymentMethod).toBe('BANK_TRANSFER');

    const txn = await prisma.paymentTransaction.findFirst({
      where: { orderId: ids.orderId, provider: 'BANK_TRANSFER' },
    });
    expect(txn?.status).toBe('PENDING');
  });
});
