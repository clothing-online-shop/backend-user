# Order Thank-You Page (BE) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Thêm `GET /orders/:orderCode` để trang cảm ơn đọc lại được đơn hàng bất kỳ lúc nào, và bổ sung email xác nhận đơn đầy đủ chi tiết (sản phẩm, địa chỉ, phương thức thanh toán) thay vì chỉ mã đơn + tổng tiền.

**Architecture:** Cả 2 phần dùng lại 100% dữ liệu/hạ tầng đã có từ Create Order API — không schema mới, không query mới ngoài 1 `findUnique` theo `orderCode`. `GET /orders/:orderCode` tái dùng `toOrderResponse()` sẵn có; email template nhận thêm field từ chính object `order` đã tạo trong transaction, không query lại DB.

**Tech Stack:** NestJS, Prisma, Jest (unit + e2e), nodemailer (đã wiring sẵn qua `MailService`).

## Global Constraints

- Route mới giữ nguyên `@UseGuards(JwtAuthGuard)` như route `POST /orders` hiện có.
- Không tìm thấy đơn HOẶC đơn không thuộc về user hiện tại → `NotFoundException('Không tìm thấy đơn hàng.')` (404) — không phân biệt 2 case để tránh lộ thông tin tồn tại, khớp pattern đã dùng trong `createOrder()`.
- `Prisma.Decimal` phải `.toNumber()` trước khi ra khỏi service boundary (response HTTP hoặc truyền cho `MailService`) — không để lọt kiểu `Decimal`/string ra ngoài.
- Chỉ hỗ trợ `PaymentProvider.COD` — nhãn hiển thị trong email cố định `"Thanh toán khi nhận hàng (COD)"`, không cần bảng map nhiều giá trị.
- Chạy `pnpm --filter @clothing-shop/be lint` + `pnpm --filter @clothing-shop/be build` trước khi coi bất kỳ task nào xong.

---

### Task 1: `GET /orders/:orderCode`

**Files:**
- Modify: `src/modules/orders/orders.service.ts` (thêm method `getOrderByCode`)
- Modify: `src/modules/orders/orders.controller.ts` (thêm route `GET :orderCode`)
- Test: `src/modules/orders/orders.service.spec.ts` (thêm `describe('OrdersService.getOrderByCode', ...)`)

**Interfaces:**
- Consumes: `toOrderResponse(order: OrderWithItems)` — hàm module-level đã có sẵn ở cuối `orders.service.ts` (map `Prisma.Decimal` → `number` cho `totalAmount`/`priceAtPurchase`).
- Produces: `OrdersService.getOrderByCode(userId: string, orderCode: string): Promise<ReturnType<typeof toOrderResponse>>` — Task 3 (e2e) gọi qua HTTP route, không gọi trực tiếp.

- [ ] **Step 1: Viết test thất bại cho `getOrderByCode`**

Thêm vào cuối `src/modules/orders/orders.service.spec.ts` (sau `describe('OrdersService.createOrder', ...)`, cùng file, không tạo file mới — theo đúng cấu trúc hiện có nơi mọi test của `OrdersService` nằm chung 1 file):

```typescript
describe('OrdersService.getOrderByCode', () => {
  function createGetOrderMocks() {
    const orderFindUnique = jest.fn();
    const prisma = {
      order: { findUnique: orderFindUnique },
    } as unknown as PrismaService;
    const mail = {} as unknown as MailService;
    return { prisma, mail, orderFindUnique };
  }

  function orderRow(
    overrides: Partial<{ id: string; userId: string; orderCode: string }> = {},
  ) {
    return {
      id: overrides.id ?? 'order-1',
      userId: overrides.userId ?? 'user-1',
      orderCode: overrides.orderCode ?? 'DH20260821ABCDEF',
      status: 'PENDING',
      totalAmount: new Prisma.Decimal('300000'),
      shippingAddress: 'Nguyễn Văn A - 0900000000 - 123 Đường ABC, Phường 1, Quận 1, TP. Hồ Chí Minh',
      paymentMethod: PaymentProvider.COD,
      items: [
        {
          id: 'item-1',
          productVariantId: 'variant-1',
          productName: 'Áo thun basic',
          variantSku: 'SKU-1',
          size: 'M',
          color: 'Đen',
          thumbnail: null,
          quantity: 2,
          priceAtPurchase: new Prisma.Decimal('150000'),
        },
      ],
    };
  }

  it('trả đúng đơn khi orderCode tồn tại và thuộc về user', async () => {
    const { prisma, mail, orderFindUnique } = createGetOrderMocks();
    orderFindUnique.mockResolvedValue(orderRow());

    const service = new OrdersService(prisma, mail);
    const result = await service.getOrderByCode('user-1', 'DH20260821ABCDEF');

    expect(orderFindUnique).toHaveBeenCalledWith({
      where: { orderCode: 'DH20260821ABCDEF' },
      include: { items: true },
    });
    expect(result.orderCode).toBe('DH20260821ABCDEF');
    expect(typeof result.totalAmount).toBe('number');
    expect(result.totalAmount).toBe(300000);
    expect(typeof result.items[0].priceAtPurchase).toBe('number');
  });

  it('không tìm thấy orderCode → NotFoundException', async () => {
    const { prisma, mail, orderFindUnique } = createGetOrderMocks();
    orderFindUnique.mockResolvedValue(null);

    const service = new OrdersService(prisma, mail);
    await expect(
      service.getOrderByCode('user-1', 'DH-NOT-EXIST'),
    ).rejects.toThrow(NotFoundException);
  });

  it('orderCode tồn tại nhưng thuộc về user khác → NotFoundException', async () => {
    const { prisma, mail, orderFindUnique } = createGetOrderMocks();
    orderFindUnique.mockResolvedValue(orderRow({ userId: 'user-2' }));

    const service = new OrdersService(prisma, mail);
    await expect(
      service.getOrderByCode('user-1', 'DH20260821ABCDEF'),
    ).rejects.toThrow(NotFoundException);
  });
});
```

- [ ] **Step 2: Chạy test để xác nhận fail**

Run: `pnpm --filter @clothing-shop/be test -- orders.service.spec.ts`
Expected: FAIL — `getOrderByCode` chưa tồn tại trên `OrdersService` (lỗi kiểu "is not a function" hoặc TS compile error).

- [ ] **Step 3: Implement `getOrderByCode` trong `orders.service.ts`**

Thêm method này vào class `OrdersService`, đặt sau `createOrder()` (trước `lockVariants`):

```typescript
  async getOrderByCode(userId: string, orderCode: string) {
    const order = await this.prisma.order.findUnique({
      where: { orderCode },
      include: { items: true },
    });
    if (!order || order.userId !== userId) {
      throw new NotFoundException('Không tìm thấy đơn hàng.');
    }
    return toOrderResponse(order);
  }
```

- [ ] **Step 4: Thêm route trong `orders.controller.ts`**

Thay nội dung file thành:

```typescript
import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import { OrdersService } from './orders.service';
import { CreateOrderDto } from './dto/create-order.dto';

@ApiTags('orders')
@ApiBearerAuth()
@Controller('orders')
@UseGuards(JwtAuthGuard)
export class OrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  @Post()
  @ApiOperation({
    summary:
      'Tạo đơn hàng từ giỏ hàng — sinh mã đơn, snapshot giá/thông tin sản phẩm, trừ tồn kho, đặt trạng thái Chờ xác nhận, ghi lịch sử trạng thái',
  })
  createOrder(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateOrderDto,
  ) {
    return this.ordersService.createOrder(user.id, dto);
  }

  @Get(':orderCode')
  @ApiOperation({
    summary:
      'Lấy chi tiết đơn hàng theo mã đơn — dùng cho trang cảm ơn/theo dõi đơn, chỉ trả về nếu đơn thuộc về user hiện tại',
  })
  getOrderByCode(
    @CurrentUser() user: AuthenticatedUser,
    @Param('orderCode') orderCode: string,
  ) {
    return this.ordersService.getOrderByCode(user.id, orderCode);
  }
}
```

- [ ] **Step 5: Chạy test để xác nhận pass**

Run: `pnpm --filter @clothing-shop/be test -- orders.service.spec.ts`
Expected: PASS — toàn bộ test trong file (cả `createOrder` cũ lẫn `getOrderByCode` mới).

- [ ] **Step 6: Lint + build**

Run: `pnpm --filter @clothing-shop/be lint && pnpm --filter @clothing-shop/be build`
Expected: 0 lỗi.

- [ ] **Step 7: Commit**

```bash
git add src/modules/orders/orders.service.ts src/modules/orders/orders.controller.ts src/modules/orders/orders.service.spec.ts
git commit -m "feat: thêm GET /orders/:orderCode cho trang cảm ơn"
```

---

### Task 2: Email xác nhận đơn — bổ sung đầy đủ chi tiết

**Files:**
- Modify: `src/modules/mail/templates/email.templates.ts` (mở rộng `orderConfirmationEmailTemplate`)
- Modify: `src/modules/mail/mail.service.ts` (mở rộng `sendOrderConfirmationEmail`)
- Modify: `src/modules/orders/orders.service.ts` (`sendConfirmationEmailBestEffort` truyền đủ field)
- Test: `src/modules/mail/templates/email.templates.spec.ts` (file mới)

**Interfaces:**
- Consumes: `OrderWithItems` (type đã có ở Task 1's context, khai ở đầu `orders.service.ts`) — cụ thể các field dùng: `orderCode`, `totalAmount: Prisma.Decimal`, `shippingAddress: string`, `paymentMethod: PaymentProvider`, `items: { productName, size, color, quantity, priceAtPurchase: Prisma.Decimal }[]`.
- Produces: `orderConfirmationEmailTemplate(order: OrderConfirmationEmailData): { subject: string; html: string }` với `OrderConfirmationEmailData` khai trong `email.templates.ts` — export type này để `mail.service.ts` dùng lại nguyên chữ ký, không định nghĩa trùng.

- [ ] **Step 1: Viết test thất bại cho template**

Tạo file mới `src/modules/mail/templates/email.templates.spec.ts`:

```typescript
import { orderConfirmationEmailTemplate } from './email.templates';

describe('orderConfirmationEmailTemplate', () => {
  it('render đủ mã đơn, sản phẩm, địa chỉ, phương thức thanh toán, tổng tiền', () => {
    const { subject, html } = orderConfirmationEmailTemplate({
      orderCode: 'DH20260821ABCDEF',
      totalAmount: 300000,
      shippingAddress: 'Nguyễn Văn A - 0900000000 - 123 Đường ABC, Phường 1, Quận 1, TP. Hồ Chí Minh',
      paymentMethod: 'COD',
      items: [
        {
          productName: 'Áo thun basic',
          size: 'M',
          color: 'Đen',
          quantity: 2,
          priceAtPurchase: 150000,
        },
      ],
    });

    expect(subject).toBe('Xác nhận đơn hàng #DH20260821ABCDEF');
    expect(html).toContain('DH20260821ABCDEF');
    expect(html).toContain('Áo thun basic');
    expect(html).toContain('M');
    expect(html).toContain('Đen');
    expect(html).toContain('123 Đường ABC');
    expect(html).toContain('Thanh toán khi nhận hàng (COD)');
    expect(html).toContain('300.000');
    expect(html).toContain('150.000');
  });
});
```

- [ ] **Step 2: Chạy test để xác nhận fail**

Run: `pnpm --filter @clothing-shop/be test -- email.templates.spec.ts`
Expected: FAIL — chữ ký `orderConfirmationEmailTemplate` hiện tại chỉ nhận `{orderCode, totalAmount}`, chưa có `shippingAddress`/`paymentMethod`/`items`, TS compile error.

- [ ] **Step 3: Mở rộng `orderConfirmationEmailTemplate` trong `email.templates.ts`**

Thay hàm `orderConfirmationEmailTemplate` (giữ nguyên `layout()` và các template khác không đổi) thành:

```typescript
export interface OrderConfirmationEmailItem {
  productName: string;
  size: string;
  color: string;
  quantity: number;
  priceAtPurchase: number;
}

export interface OrderConfirmationEmailData {
  orderCode: string;
  totalAmount: number;
  shippingAddress: string;
  paymentMethod: string;
  items: OrderConfirmationEmailItem[];
}

// Chỉ hỗ trợ COD ở thời điểm này (xem PaymentProvider trong schema.prisma) — map trực
// tiếp 1 giá trị, không cần bảng map nhiều phương thức cho tới khi có provider thứ 2.
function paymentMethodLabel(paymentMethod: string): string {
  if (paymentMethod === 'COD') return 'Thanh toán khi nhận hàng (COD)';
  return paymentMethod;
}

export function orderConfirmationEmailTemplate(
  order: OrderConfirmationEmailData,
): { subject: string; html: string } {
  const itemsHtml = order.items
    .map(
      (item) => `
        <tr>
          <td style="padding: 8px 0; border-bottom: 1px solid #eee;">
            ${item.productName} (${item.size} / ${item.color})
          </td>
          <td style="padding: 8px 0; border-bottom: 1px solid #eee; text-align: center;">
            x${item.quantity}
          </td>
          <td style="padding: 8px 0; border-bottom: 1px solid #eee; text-align: right;">
            ${item.priceAtPurchase.toLocaleString('vi-VN')}đ
          </td>
        </tr>`,
    )
    .join('');

  return {
    subject: `Xác nhận đơn hàng #${order.orderCode}`,
    html: layout(
      'Đặt hàng thành công',
      `<p>Cảm ơn bạn đã đặt hàng tại Clothing Shop.</p>
       <p>Mã đơn hàng: <strong>${order.orderCode}</strong></p>
       <table style="width: 100%; border-collapse: collapse; margin: 16px 0;">
         ${itemsHtml}
       </table>
       <p>Địa chỉ giao hàng: <strong>${order.shippingAddress}</strong></p>
       <p>Phương thức thanh toán: <strong>${paymentMethodLabel(order.paymentMethod)}</strong></p>
       <p>Tổng tiền: <strong>${order.totalAmount.toLocaleString('vi-VN')}đ</strong></p>
       <p>Chúng tôi sẽ xử lý đơn hàng của bạn trong thời gian sớm nhất.</p>`,
    ),
  };
}
```

- [ ] **Step 4: Chạy test template để xác nhận pass**

Run: `pnpm --filter @clothing-shop/be test -- email.templates.spec.ts`
Expected: PASS.

- [ ] **Step 5: Cập nhật `mail.service.ts` để dùng type mới**

Trong `src/modules/mail/mail.service.ts`, sửa import và method `sendOrderConfirmationEmail`:

```typescript
import {
  orderConfirmationEmailTemplate,
  otpEmailTemplate,
  passwordResetEmailTemplate,
  welcomeEmailTemplate,
  type OrderConfirmationEmailData,
} from './templates/email.templates';
```

```typescript
  async sendOrderConfirmationEmail(
    to: string,
    order: OrderConfirmationEmailData,
  ): Promise<void> {
    const { subject, html } = orderConfirmationEmailTemplate(order);
    await this.send(to, subject, html);
  }
```

- [ ] **Step 6: Cập nhật `sendConfirmationEmailBestEffort` trong `orders.service.ts` để truyền đủ field**

Thay method này (giữ nguyên phần try/catch/logger.warn, chỉ đổi tham số và nội dung gọi `sendOrderConfirmationEmail`):

```typescript
  private async sendConfirmationEmailBestEffort(
    userId: string,
    order: OrderWithItems,
  ): Promise<void> {
    try {
      const user = await this.prisma.user.findUniqueOrThrow({
        where: { id: userId },
        select: { email: true },
      });
      await this.mail.sendOrderConfirmationEmail(user.email, {
        orderCode: order.orderCode,
        totalAmount: order.totalAmount.toNumber(),
        shippingAddress: order.shippingAddress,
        paymentMethod: order.paymentMethod,
        items: order.items.map((item) => ({
          productName: item.productName,
          size: item.size,
          color: item.color,
          quantity: item.quantity,
          priceAtPurchase: item.priceAtPurchase.toNumber(),
        })),
      });
    } catch (err) {
      this.logger.warn(
        `Không gửi được email xác nhận đơn hàng ${order.orderCode}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
```

Lưu ý: call site duy nhất của hàm này (`void this.sendConfirmationEmailBestEffort(userId, order);` trong `createOrder()`) không cần đổi — đã truyền `order` (kết quả `tx.order.create(...)`, đúng kiểu `OrderWithItems`) từ trước, chỉ có chữ ký tham số của hàm là đổi.

- [ ] **Step 7: Lint + build**

Run: `pnpm --filter @clothing-shop/be lint && pnpm --filter @clothing-shop/be build`
Expected: 0 lỗi. Nếu TS báo lỗi kiểu ở `sendConfirmationEmailBestEffort` (vd `paymentMethod` là enum `PaymentProvider` nhưng `OrderConfirmationEmailData.paymentMethod` khai `string`) — `PaymentProvider` là string enum nên gán được thẳng vào `string`, không cần ép kiểu; nếu build vẫn báo lỗi, kiểm tra lại đúng tên field đã khớp schema (`orders.service.ts` đầu file, `OrderWithItems`).

- [ ] **Step 8: Chạy lại toàn bộ unit test**

Run: `pnpm --filter @clothing-shop/be test`
Expected: PASS toàn bộ (bao gồm cả `orders.service.spec.ts` — test tạo đơn thành công gọi `sendOrderConfirmationEmail` qua mock `sendOrderConfirmationEmail = jest.fn()`, không assert chi tiết tham số nên không bị ảnh hưởng bởi việc mở rộng field).

- [ ] **Step 9: Commit**

```bash
git add src/modules/mail/templates/email.templates.ts src/modules/mail/templates/email.templates.spec.ts src/modules/mail/mail.service.ts src/modules/orders/orders.service.ts
git commit -m "feat: bổ sung chi tiết sản phẩm/địa chỉ/thanh toán vào email xác nhận đơn"
```

---

### Task 3: E2E test cho `GET /orders/:orderCode`

**Files:**
- Modify: `test/orders.e2e-spec.ts`

**Interfaces:**
- Consumes: route `GET /orders/:orderCode` từ Task 1, response shape `CreateOrderResponse` (interface đã có sẵn trong file, tái dùng nguyên vì response shape của GET giống hệt POST).

- [ ] **Step 1: Thêm biến lưu orderCode và test GET vào `test/orders.e2e-spec.ts`**

Thêm `let createdOrderCode: string;` vào khối khai biến đầu `describe` (cạnh `let token: string;`).

Trong test `'POST /orders — tạo đơn thành công...'`, ngay sau dòng `const orderId = body.id;`, thêm:

```typescript
    createdOrderCode = body.orderCode;
```

Thêm 2 test mới vào cuối file, trước dấu đóng `});` cuối cùng của `describe`:

```typescript
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
```

- [ ] **Step 2: Chạy e2e test**

Run: `pnpm --filter @clothing-shop/be test:e2e -- orders.e2e-spec.ts`
Expected: PASS toàn bộ 4 test trong file (2 test POST cũ + 2 test GET mới). Cần Postgres đang chạy — nếu lỗi kết nối DB, khởi động Postgres trước rồi chạy lại (không phải lỗi code).

- [ ] **Step 3: Lint + build lần cuối**

Run: `pnpm --filter @clothing-shop/be lint && pnpm --filter @clothing-shop/be build`
Expected: 0 lỗi.

- [ ] **Step 4: Commit**

```bash
git add test/orders.e2e-spec.ts
git commit -m "test: thêm e2e cho GET /orders/:orderCode"
```
