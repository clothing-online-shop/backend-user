# Create Order API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement `POST /orders` in `backend-user` — creates an order from the user's cart: generates an order code, snapshots product/price info onto `OrderItem`, atomically decrements stock, sets status `PENDING`, and records the initial order status history entry.

**Architecture:** Two repos are involved. `backend-cms` owns the shared Prisma schema (via git submodule `vendor/backend-cms` inside `backend-user`) — it gets two additions: snapshot columns on `OrderItem` and a new `OrderStatusHistory` table. `backend-user` owns all business logic: `OrdersService.createOrder()` does a preflight validation pass (fast, clear errors), then an atomic Prisma transaction that row-locks the affected `ProductVariant`s (`SELECT ... FOR UPDATE`, sorted by id to avoid deadlocks — mirrors the existing pattern in `backend-cms/src/modules/inventory/inventory.service.ts`), decrements stock, writes `StockMovement` + `OrderStatusHistory`, creates the `Order`, and clears the purchased cart items.

**Tech Stack:** NestJS, TypeScript, Prisma (PostgreSQL), Jest, class-validator, Swagger.

**Spec:** `docs/superpowers/specs/2026-08-20-create-order-api-design.md` (this repo).

## Global Constraints

- Only `PaymentProvider.COD` is accepted as `paymentMethod` for this feature — reject others with `BadRequestException` at the service layer (DTO validates the full enum, per spec §6).
- Order creation is scoped to items already in the user's cart (`cartItemIds`) — no "buy now" / direct item list support in this feature.
- Shipping address comes from an existing saved `Address` (`addressId`), formatted into a snapshot string — never accept raw address text.
- `OrderItem` gets real snapshot columns (`productName`, `variantSku`, `size`, `color`, `thumbnail`) — never rely on a live join to `Product`/`ProductVariant` for historical order display.
- Order status history is a dedicated `OrderStatusHistory` table — never reuse `AuditLog` for this.
- Stock decrement must use `SELECT ... FOR UPDATE` locking (sorted by variant id), matching the established pattern in `backend-cms/src/modules/inventory/inventory.service.ts` — not an optimistic `updateMany` pattern.
- Every new/moved helper function used in ≥2 modules goes in `src/common/utils/`, per `backend-user/CLAUDE.md`.
- Orders module requires both unit and e2e tests before being considered done, per `backend-user/CLAUDE.md` ("Test" section).

## Repo & Branch Setup (already done)

- `backend-cms` (path: `c:\Users\duypd\Downloads\DA\backend-cms`): branch `feature/order-item-snapshot-and-status-history`, created off `fix-develop` (that repo's `develop` is currently stale relative to `fix-develop`).
- `backend-user` (path: `c:\Users\duypd\Downloads\DA\backend-user`): branch `feature/create-order-api`, created off `fix-develop` (same staleness situation; already has 1 commit with the design spec).

All commands below assume the working directory is the repo named at the start of each task.

---

### Task 1: Schema — `OrderItem` snapshot columns + `OrderStatusHistory` table

**Repo:** `backend-cms` (branch `feature/order-item-snapshot-and-status-history`)

**Files:**
- Modify: `prisma/schema.prisma`

**Interfaces:**
- Produces: Prisma models `OrderItem` (new fields `productName: String`, `variantSku: String`, `size: String`, `color: String`, `thumbnail: String?`) and `OrderStatusHistory` (new model) — consumed by Task 2 (submodule bump) and Task 6 (`OrdersService`) in `backend-user`.

- [ ] **Step 1: Edit the `OrderItem` model**

Replace:
```prisma
model OrderItem {
  id               String  @id @default(cuid())
  orderId          String
  productVariantId String
  quantity         Int
  priceAtPurchase  Decimal @db.Decimal(12, 2)

  order          Order          @relation(fields: [orderId], references: [id], onDelete: Cascade)
  productVariant ProductVariant @relation(fields: [productVariantId], references: [id])

  @@index([orderId])
  @@map("order_items")
}
```

With:
```prisma
model OrderItem {
  id               String  @id @default(cuid())
  orderId          String
  productVariantId String
  productName      String
  variantSku       String
  size             String
  color            String
  thumbnail        String?
  quantity         Int
  priceAtPurchase  Decimal @db.Decimal(12, 2)

  order          Order          @relation(fields: [orderId], references: [id], onDelete: Cascade)
  // Restrict (không phải mặc định) — biến thể đã có trong đơn hàng không được xoá cứng,
  // giống lý do đã áp dụng cho StockMovement.productVariant.
  productVariant ProductVariant @relation(fields: [productVariantId], references: [id], onDelete: Restrict)

  @@index([orderId])
  @@map("order_items")
}
```

- [ ] **Step 2: Add the `OrderStatusHistory` model**

Insert immediately after the `OrderItem` model block (before `model Coupon {`):
```prisma
// Lịch sử thay đổi trạng thái của 1 đơn hàng — mỗi lần status đổi (kể cả lúc tạo đơn) ghi
// 1 dòng ở đây, dùng để hiển thị timeline đơn hàng cho khách/admin. Tách riêng khỏi
// AuditLog (bảng đó dùng cho hành động CUD chung của admin, không phải timeline nghiệp vụ
// của 1 đơn hàng cụ thể).
model OrderStatusHistory {
  id          String       @id @default(cuid())
  orderId     String
  fromStatus  OrderStatus?
  toStatus    OrderStatus
  note        String?
  changedById String? // null = hệ thống tự ghi (ví dụ lúc tạo đơn), có giá trị nếu admin đổi trạng thái tay
  createdAt   DateTime     @default(now())

  order     Order @relation(fields: [orderId], references: [id], onDelete: Cascade)
  changedBy User? @relation(fields: [changedById], references: [id])

  @@index([orderId])
  @@map("order_status_histories")
}
```

- [ ] **Step 3: Add the reverse relation on `Order`**

In `model Order { ... }`, change:
```prisma
  user         User                 @relation(fields: [userId], references: [id])
  items        OrderItem[]
  transactions PaymentTransaction[]
```
to:
```prisma
  user            User                 @relation(fields: [userId], references: [id])
  items           OrderItem[]
  transactions    PaymentTransaction[]
  statusHistories OrderStatusHistory[]
```

- [ ] **Step 4: Add the reverse relation on `User`**

In `model User { ... }`, change:
```prisma
  addresses      Address[]
  carts          Cart[]
  orders         Order[]
  reviews        Review[]
  refreshTokens  RefreshToken[]
  stockMovements StockMovement[]
  auditLogs      AuditLog[]
  wishlistItems  WishlistItem[]
  recentlyViewed RecentlyViewed[]
```
to:
```prisma
  addresses          Address[]
  carts              Cart[]
  orders             Order[]
  reviews            Review[]
  refreshTokens      RefreshToken[]
  stockMovements     StockMovement[]
  auditLogs          AuditLog[]
  wishlistItems      WishlistItem[]
  recentlyViewed     RecentlyViewed[]
  orderStatusChanges OrderStatusHistory[]
```

- [ ] **Step 5: Generate the migration**

Run: `pnpm prisma:migrate -- --name add_order_item_snapshot_and_status_history`

Expected: Prisma creates `prisma/migrations/<timestamp>_add_order_item_snapshot_and_status_history/migration.sql`, applies it to the local dev DB, and regenerates the Prisma Client with no errors. If prompted about data loss on `OrderItem` (existing rows would need values for the new non-null `productName`/`variantSku`/`size`/`color`), and there is existing seed/test data in the local DB, accept Prisma's default value prompt or confirm the table is empty before proceeding — do not hand-edit the generated SQL.

- [ ] **Step 6: Verify**

Run: `pnpm build` — must succeed (confirms the regenerated Prisma Client types are valid and nothing else in `backend-cms` broke from the `OrderItem`/`Order`/`User` relation changes).

- [ ] **Step 7: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat(schema): add OrderItem snapshot columns and OrderStatusHistory table"
```

---

### Task 2: Bump `vendor/backend-cms` submodule in `backend-user`

**Repo:** `backend-user` (branch `feature/create-order-api`)

**Files:**
- Modify: `vendor/backend-cms` (submodule pointer)

**Interfaces:**
- Consumes: Task 1's commit in `backend-cms` (branch `feature/order-item-snapshot-and-status-history`).
- Produces: regenerated `@prisma/client` types (`OrderStatus`, `PaymentProvider`, `StockMovementType`, `Prisma` namespace with the new `OrderItem`/`OrderStatusHistory` shapes) — consumed by every later task in this repo.

- [ ] **Step 1: Fetch the new commit from the sibling `backend-cms` working directory (no push needed yet)**

```bash
cd vendor/backend-cms
git fetch ../../../backend-cms feature/order-item-snapshot-and-status-history
git checkout FETCH_HEAD
cd ../..
```

Expected: `git -C vendor/backend-cms log -1 --oneline` shows the "feat(schema): add OrderItem snapshot columns and OrderStatusHistory table" commit from Task 1.

- [ ] **Step 2: Stage the submodule bump and regenerate the Prisma Client**

```bash
git add vendor/backend-cms
pnpm prisma:generate
```

Expected: no errors. `node_modules/@prisma/client` now exposes the new `OrderItem` fields and the `OrderStatusHistory` model/delegate.

- [ ] **Step 3: Verify the app still builds**

Run: `pnpm build`
Expected: succeeds (confirms nothing existing in `backend-user` broke from the schema change — e.g. any code constructing an `OrderItem` object without the new required fields would fail to compile here, but no such code exists yet since `orders.service.ts` is still a stub).

- [ ] **Step 4: Commit**

```bash
git commit -m "chore: bump vendor/backend-cms submodule (OrderItem snapshot + OrderStatusHistory)"
```

---

### Task 3: Extract `isProductAvailable` into a shared util

**Repo:** `backend-user` (branch `feature/create-order-api`)

**Files:**
- Create: `src/common/utils/product-availability.util.ts`
- Modify: `src/modules/cart/cart.service.ts`

**Interfaces:**
- Produces: `isProductAvailable(product: Pick<Product, 'status' | 'isDelete'>): boolean` — consumed by `cart.service.ts` (existing 3 call sites) and Task 6's `orders.service.ts`.

- [ ] **Step 1: Create the shared util**

`src/common/utils/product-availability.util.ts`:
```ts
import { Product } from '@prisma/client';
import { ProductStatus } from '../../modules/products/product-status.enum';

// "Khả dụng để mua" phải xét cả 2 điều kiện: status ACTIVE VÀ chưa bị xóa mềm — sản phẩm
// bị admin xóa mềm bên backend-cms (ProductsService.remove() chỉ set isDelete: true,
// không đổi status) vẫn còn status ACTIVE. Dùng chung giữa CartService và OrdersService,
// không copy-paste lại.
export function isProductAvailable(
  product: Pick<Product, 'status' | 'isDelete'>,
): boolean {
  // Product.status là Int thô ở tầng Prisma (không phải enum DB) — gán qua biến khai kiểu
  // ProductStatus trước khi so sánh, khớp pattern đã dùng ở chỗ khác trong repo, để không
  // dính lint no-unsafe-enum-comparison (so number thô với enum TS).
  const status: ProductStatus = product.status;
  return status === ProductStatus.ACTIVE && !product.isDelete;
}
```

- [ ] **Step 2: Update `cart.service.ts` to import it instead of defining it locally**

At the top of `src/modules/cart/cart.service.ts`, add the import (alongside the existing `ProductStatus` import):
```ts
import { isProductAvailable } from '../../common/utils/product-availability.util';
```

Delete the local function definition and its comment block at the bottom of the file:
```ts
// Dùng chung cho addItem/mergeCart/validateCart — "khả dụng để mua" phải xét cả 2 điều
// kiện: status ACTIVE VÀ chưa bị xóa mềm. Trước đây chỉ check status, bỏ sót isDelete: sản
// phẩm bị admin xóa mềm bên backend-cms (ProductsService.remove() chỉ set isDelete: true,
// không đổi status — xem products.service.ts) vẫn còn status ACTIVE, nên vẫn lọt qua các
// check "!== ProductStatus.ACTIVE" cũ, để khách thêm/giữ được trong giỏ 1 sản phẩm đã biến
// mất khỏi catalog.
function isProductAvailable(
  product: Pick<Product, 'status' | 'isDelete'>,
): boolean {
  // Product.status là Int thô ở tầng Prisma (không phải enum DB) — gán qua biến khai kiểu
  // ProductStatus trước khi so sánh, khớp pattern đã dùng ở chỗ khác trong repo, để không
  // dính lint no-unsafe-enum-comparison (so number thô với enum TS).
  const status: ProductStatus = product.status;
  return status === ProductStatus.ACTIVE && !product.isDelete;
}
```

Leave every call site (`isProductAvailable(...)`) untouched — same name, same signature, now resolved via the import.

If `Product` is no longer referenced anywhere else in `cart.service.ts` after removing this function, remove it from the top-of-file `import { Cart, CartItem, Product, ProductVariant } from '@prisma/client';` too — check with a grep for `Product` (not `ProductVariant`/`CartItem`) in the rest of the file before removing.

- [ ] **Step 3: Run the existing cart tests to confirm no regression**

Run: `pnpm test cart.service.spec.ts`
Expected: all existing tests still PASS (behavior unchanged, only the function's location moved).

- [ ] **Step 4: Commit**

```bash
git add src/common/utils/product-availability.util.ts src/modules/cart/cart.service.ts
git commit -m "refactor: extract isProductAvailable into shared util for reuse in orders"
```

---

### Task 4: `generateOrderCode` util

**Repo:** `backend-user` (branch `feature/create-order-api`)

**Files:**
- Create: `src/common/utils/order-code.util.ts`
- Test: `src/common/utils/order-code.util.spec.ts`

**Interfaces:**
- Produces: `generateOrderCode(now?: Date): string` — consumed by Task 6's `orders.service.ts`.

- [ ] **Step 1: Write the failing test**

`src/common/utils/order-code.util.spec.ts`:
```ts
import { generateOrderCode } from './order-code.util';

describe('generateOrderCode', () => {
  it('sinh mã đúng định dạng DH + yyyyMMdd (UTC) + 6 ký tự hoa/số', () => {
    const fixedDate = new Date('2026-08-20T10:00:00.000Z');
    const code = generateOrderCode(fixedDate);
    expect(code).toMatch(/^DH20260820[A-Z0-9]{6}$/);
  });

  it('sinh 2 mã khác nhau ở 2 lần gọi liên tiếp cùng thời điểm (phần random khác nhau)', () => {
    const fixedDate = new Date('2026-08-20T10:00:00.000Z');
    const code1 = generateOrderCode(fixedDate);
    const code2 = generateOrderCode(fixedDate);
    expect(code1).not.toBe(code2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test order-code.util.spec.ts`
Expected: FAIL — `Cannot find module './order-code.util'`.

- [ ] **Step 3: Write the implementation**

`src/common/utils/order-code.util.ts`:
```ts
const CODE_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const RANDOM_PART_LENGTH = 6;

// Dùng UTC (không phải giờ local server) cho phần ngày — tránh mã đơn lệch ngày nếu server
// deploy ở timezone khác VN (Render mặc định chạy UTC).
export function generateOrderCode(now: Date = new Date()): string {
  const datePart = formatDatePart(now);
  let randomPart = '';
  for (let i = 0; i < RANDOM_PART_LENGTH; i++) {
    randomPart += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  }
  return `DH${datePart}${randomPart}`;
}

function formatDatePart(date: Date): string {
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  return `${yyyy}${mm}${dd}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test order-code.util.spec.ts`
Expected: PASS (both tests).

- [ ] **Step 5: Commit**

```bash
git add src/common/utils/order-code.util.ts src/common/utils/order-code.util.spec.ts
git commit -m "feat: add generateOrderCode util for order creation"
```

---

### Task 5: `CreateOrderDto`

**Repo:** `backend-user` (branch `feature/create-order-api`)

**Files:**
- Create: `src/modules/orders/dto/create-order.dto.ts`

**Interfaces:**
- Produces: `CreateOrderDto { addressId: string; cartItemIds: string[]; paymentMethod: PaymentProvider }` — consumed by Task 6 (`OrdersService.createOrder`) and Task 7 (`OrdersController`).

- [ ] **Step 1: Create the DTO**

`src/modules/orders/dto/create-order.dto.ts`:
```ts
import { ApiProperty } from '@nestjs/swagger';
import { PaymentProvider } from '@prisma/client';
import { ArrayMinSize, IsArray, IsEnum, IsString } from 'class-validator';

export class CreateOrderDto {
  @ApiProperty({ description: 'Id địa chỉ giao hàng đã lưu trong sổ địa chỉ' })
  @IsString()
  addressId!: string;

  @ApiProperty({
    description: 'Danh sách id các dòng trong giỏ hàng muốn thanh toán',
    type: [String],
  })
  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  cartItemIds!: string[];

  @ApiProperty({
    enum: PaymentProvider,
    description: 'Phương thức thanh toán — hiện chỉ hỗ trợ COD',
  })
  @IsEnum(PaymentProvider)
  paymentMethod!: PaymentProvider;
}
```

There is no separate test for a plain DTO (no logic beyond decorators) — its validation behavior is exercised through Task 8's e2e test.

- [ ] **Step 2: Commit**

```bash
git add src/modules/orders/dto/create-order.dto.ts
git commit -m "feat: add CreateOrderDto"
```

---

### Task 6: `OrdersService.createOrder`

**Repo:** `backend-user` (branch `feature/create-order-api`)

**Files:**
- Modify: `src/modules/orders/orders.service.ts`
- Test: `src/modules/orders/orders.service.spec.ts`

**Interfaces:**
- Consumes: `isProductAvailable` (Task 3), `generateOrderCode` (Task 4), `CreateOrderDto` (Task 5), `PrismaService` (`../../config/prisma.service`), `MailService.sendOrderConfirmationEmail(to: string, order: { orderCode: string; totalAmount: number }): Promise<void>` (already exists in `src/modules/mail/mail.service.ts`).
- Produces: `OrdersService.createOrder(userId: string, dto: CreateOrderDto): Promise<Order & { items: OrderItem[] }>` — consumed by Task 7 (`OrdersController`) and Task 8 (e2e test).

This task builds the method through several TDD cycles in the same two files. Write each test, watch it fail for the right reason, extend the implementation, watch the growing test file pass, then commit once at the end of the task (the tests all describe one cohesive method — see "Task Right-Sizing" in this plan's source skill).

- [ ] **Step 1: Write the test file skeleton + happy-path test**

`src/modules/orders/orders.service.spec.ts`:
```ts
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { PaymentProvider, Prisma } from '@prisma/client';
import { OrdersService } from './orders.service';
import { PrismaService } from '../../config/prisma.service';
import { MailService } from '../mail/mail.service';
import { ProductStatus } from '../products/product-status.enum';
import { CreateOrderDto } from './dto/create-order.dto';

function createMocks() {
  const addressFindUnique = jest.fn();
  const cartItemFindMany = jest.fn();
  const userFindUniqueOrThrow = jest
    .fn()
    .mockResolvedValue({ email: 'user@example.com' });

  const queryRaw = jest.fn();
  const productFindMany = jest.fn();
  const stockMovementCreate = jest.fn().mockResolvedValue({});
  const productVariantUpdate = jest.fn().mockResolvedValue({});
  const orderCreate = jest.fn();
  const orderStatusHistoryCreate = jest.fn().mockResolvedValue({});
  const cartItemDeleteMany = jest.fn().mockResolvedValue({ count: 1 });

  const tx = {
    $queryRaw: queryRaw,
    product: { findMany: productFindMany },
    stockMovement: { create: stockMovementCreate },
    productVariant: { update: productVariantUpdate },
    order: { create: orderCreate },
    orderStatusHistory: { create: orderStatusHistoryCreate },
    cartItem: { deleteMany: cartItemDeleteMany },
  };

  const transaction = jest.fn((cb: (tx: unknown) => unknown) => cb(tx));

  const prisma = {
    address: { findUnique: addressFindUnique },
    cartItem: { findMany: cartItemFindMany },
    user: { findUniqueOrThrow: userFindUniqueOrThrow },
    $transaction: transaction,
  } as unknown as PrismaService;

  const sendOrderConfirmationEmail = jest.fn().mockResolvedValue(undefined);
  const mail = { sendOrderConfirmationEmail } as unknown as MailService;

  return {
    prisma,
    mail,
    tx,
    addressFindUnique,
    cartItemFindMany,
    userFindUniqueOrThrow,
    queryRaw,
    productFindMany,
    stockMovementCreate,
    productVariantUpdate,
    orderCreate,
    orderStatusHistoryCreate,
    cartItemDeleteMany,
    transaction,
    sendOrderConfirmationEmail,
  };
}

function address(overrides: Partial<{ id: string; userId: string }> = {}) {
  return {
    id: overrides.id ?? 'address-1',
    userId: overrides.userId ?? 'user-1',
    receiverName: 'Nguyễn Văn A',
    phone: '0900000000',
    detail: '123 Đường ABC',
    ward: { name: 'Phường 1' },
    district: { name: 'Quận 1' },
    province: { name: 'TP. Hồ Chí Minh' },
  };
}

function cartItem(overrides: {
  id: string;
  productVariantId: string;
  quantity: number;
  cartUserId?: string;
  status?: ProductStatus;
  stockQuantity?: number;
}) {
  return {
    id: overrides.id,
    productVariantId: overrides.productVariantId,
    quantity: overrides.quantity,
    cart: { userId: overrides.cartUserId ?? 'user-1' },
    productVariant: {
      id: overrides.productVariantId,
      stockQuantity: overrides.stockQuantity ?? 10,
      product: {
        name: 'Áo thun basic',
        status: overrides.status ?? ProductStatus.ACTIVE,
        isDelete: false,
      },
    },
  };
}

function lockedRow(overrides: {
  id: string;
  stockQuantity: number;
  price?: string;
  productId?: string;
}) {
  return {
    id: overrides.id,
    stockQuantity: overrides.stockQuantity,
    price: overrides.price ?? '150000',
    sku: `SKU-${overrides.id}`,
    size: 'M',
    color: 'Đen',
    productId: overrides.productId ?? `product-${overrides.id}`,
  };
}

function baseDto(overrides: Partial<CreateOrderDto> = {}): CreateOrderDto {
  return {
    addressId: 'address-1',
    cartItemIds: ['item-1'],
    paymentMethod: PaymentProvider.COD,
    ...overrides,
  };
}

describe('OrdersService.createOrder', () => {
  it('tạo đơn thành công: snapshot đúng, trừ kho, ghi StockMovement + OrderStatusHistory, xoá cart item', async () => {
    const { prisma, mail, addressFindUnique, cartItemFindMany, queryRaw, productFindMany, stockMovementCreate, productVariantUpdate, orderCreate, orderStatusHistoryCreate, cartItemDeleteMany } =
      createMocks();

    addressFindUnique.mockResolvedValue(address());
    cartItemFindMany.mockResolvedValue([
      cartItem({ id: 'item-1', productVariantId: 'variant-1', quantity: 2 }),
    ]);
    queryRaw.mockResolvedValue([
      lockedRow({ id: 'variant-1', stockQuantity: 10, price: '150000', productId: 'product-1' }),
    ]);
    productFindMany.mockResolvedValue([
      { id: 'product-1', name: 'Áo thun basic', thumbnail: 'thumb.jpg' },
    ]);
    orderCreate.mockResolvedValue({
      id: 'order-1',
      orderCode: 'DH20260820ABC123',
      totalAmount: new Prisma.Decimal(300000),
      items: [],
    });

    const service = new OrdersService(prisma, mail);
    const result = await service.createOrder('user-1', baseDto());

    expect(result.id).toBe('order-1');
    expect(stockMovementCreate).toHaveBeenCalledWith({
      data: {
        productVariantId: 'variant-1',
        type: 'EXPORT',
        quantity: -2,
        createdById: null,
      },
    });
    expect(productVariantUpdate).toHaveBeenCalledWith({
      where: { id: 'variant-1' },
      data: { stockQuantity: { decrement: 2 } },
    });
    expect(orderCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: 'user-1',
          status: 'PENDING',
          paymentMethod: 'COD',
          items: {
            create: [
              expect.objectContaining({
                productVariantId: 'variant-1',
                productName: 'Áo thun basic',
                variantSku: 'SKU-variant-1',
                size: 'M',
                color: 'Đen',
                thumbnail: 'thumb.jpg',
                quantity: 2,
              }),
            ],
          },
        }),
      }),
    );
    expect(orderStatusHistoryCreate).toHaveBeenCalledWith({
      data: {
        orderId: 'order-1',
        fromStatus: null,
        toStatus: 'PENDING',
        changedById: null,
      },
    });
    expect(cartItemDeleteMany).toHaveBeenCalledWith({
      where: { id: { in: ['item-1'] } },
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test orders.service.spec.ts`
Expected: FAIL — `OrdersService` has no `createOrder` method (current file is the empty stub).

- [ ] **Step 3: Implement `createOrder` (full implementation — a partial stub isn't meaningfully simpler for a transactional method like this)**

`src/modules/orders/orders.service.ts` (replace entire file contents):
```ts
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  OrderStatus,
  PaymentProvider,
  Prisma,
  StockMovementType,
} from '@prisma/client';
import { PrismaService } from '../../config/prisma.service';
import { MailService } from '../mail/mail.service';
import { isProductAvailable } from '../../common/utils/product-availability.util';
import { generateOrderCode } from '../../common/utils/order-code.util';
import { CreateOrderDto } from './dto/create-order.dto';

const ORDER_CODE_MAX_RETRIES = 3;

type RawVariantRow = {
  id: string;
  stockQuantity: number;
  price: string;
  sku: string;
  size: string;
  color: string;
  productId: string;
};

type LockedVariant = {
  id: string;
  stockQuantity: number;
  price: Prisma.Decimal;
  sku: string;
  size: string;
  color: string;
  productName: string;
  thumbnail: string | null;
};

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
  ) {}

  async createOrder(userId: string, dto: CreateOrderDto) {
    if (dto.paymentMethod !== PaymentProvider.COD) {
      throw new BadRequestException(
        'Hiện chỉ hỗ trợ thanh toán khi nhận hàng (COD).',
      );
    }

    const address = await this.prisma.address.findUnique({
      where: { id: dto.addressId },
      include: {
        province: { select: { name: true } },
        district: { select: { name: true } },
        ward: { select: { name: true } },
      },
    });
    if (!address || address.userId !== userId) {
      throw new NotFoundException('Không tìm thấy địa chỉ.');
    }

    const cartItems = await this.prisma.cartItem.findMany({
      where: { id: { in: dto.cartItemIds } },
      include: {
        cart: true,
        productVariant: { include: { product: true } },
      },
    });
    if (
      cartItems.length !== dto.cartItemIds.length ||
      cartItems.some((item) => item.cart.userId !== userId)
    ) {
      throw new NotFoundException('Không tìm thấy sản phẩm trong giỏ hàng.');
    }

    const unavailable = cartItems.filter(
      (item) =>
        !isProductAvailable(item.productVariant.product) ||
        item.quantity > item.productVariant.stockQuantity,
    );
    if (unavailable.length > 0) {
      const names = unavailable.map((item) => item.productVariant.product.name);
      throw new BadRequestException(
        `Sản phẩm không khả dụng hoặc không đủ hàng: ${names.join(', ')}.`,
      );
    }

    const shippingAddress = `${address.receiverName} - ${address.phone} - ${address.detail}, ${address.ward.name}, ${address.district.name}, ${address.province.name}`;
    const variantIds = [
      ...new Set(cartItems.map((item) => item.productVariantId)),
    ].sort();

    for (let attempt = 1; attempt <= ORDER_CODE_MAX_RETRIES; attempt++) {
      const orderCode = generateOrderCode();
      try {
        const order = await this.prisma.$transaction(async (tx) => {
          const lockedById = await this.lockVariants(tx, variantIds);

          for (const item of cartItems) {
            const variant = lockedById.get(item.productVariantId)!;
            if (item.quantity > variant.stockQuantity) {
              throw new ConflictException(
                `Sản phẩm "${variant.productName}" vừa hết hàng, vui lòng thử lại.`,
              );
            }
          }

          let totalAmount = new Prisma.Decimal(0);
          const itemsData = cartItems.map((item) => {
            const variant = lockedById.get(item.productVariantId)!;
            totalAmount = totalAmount.add(variant.price.mul(item.quantity));
            return {
              productVariantId: item.productVariantId,
              productName: variant.productName,
              variantSku: variant.sku,
              size: variant.size,
              color: variant.color,
              thumbnail: variant.thumbnail,
              quantity: item.quantity,
              priceAtPurchase: variant.price,
            };
          });

          for (const item of cartItems) {
            await tx.stockMovement.create({
              data: {
                productVariantId: item.productVariantId,
                type: StockMovementType.EXPORT,
                quantity: -item.quantity,
                createdById: null,
              },
            });
            await tx.productVariant.update({
              where: { id: item.productVariantId },
              data: { stockQuantity: { decrement: item.quantity } },
            });
          }

          const created = await tx.order.create({
            data: {
              userId,
              orderCode,
              status: OrderStatus.PENDING,
              totalAmount,
              shippingAddress,
              paymentMethod: dto.paymentMethod,
              items: { create: itemsData },
            },
            include: { items: true },
          });

          await tx.orderStatusHistory.create({
            data: {
              orderId: created.id,
              fromStatus: null,
              toStatus: OrderStatus.PENDING,
              changedById: null,
            },
          });

          await tx.cartItem.deleteMany({
            where: { id: { in: dto.cartItemIds } },
          });

          return created;
        });

        void this.sendConfirmationEmailBestEffort(userId, order);
        return order;
      } catch (err) {
        const isOrderCodeCollision =
          err instanceof Prisma.PrismaClientKnownRequestError &&
          err.code === 'P2002';
        // Lỗi khác (vd ConflictException do hết hàng phát hiện trong transaction) không
        // liên quan gì tới việc trùng mã đơn — thử lại cũng không giải quyết được, rethrow
        // ngay, không tốn thêm lượt retry.
        if (!isOrderCodeCollision) {
          throw err;
        }
        if (attempt === ORDER_CODE_MAX_RETRIES) {
          throw new ConflictException(
            'Không thể tạo mã đơn hàng, vui lòng thử lại sau.',
          );
        }
        // Còn lượt retry — vòng lặp tự sinh orderCode mới ở lần lặp kế tiếp.
      }
    }
    // Không bao giờ tới đây — vòng lặp trên luôn return hoặc throw ở lần thử cuối.
    throw new Error('unreachable');
  }

  // SELECT ... FOR UPDATE khoá các dòng ProductVariant liên quan, sắp theo id tăng dần
  // (variantIds đã được sort trước khi gọi) — đảm bảo 2 đơn hàng chứa chung sản phẩm luôn
  // lock theo cùng 1 thứ tự, tránh deadlock. Cùng lý do đã áp dụng cho lockVariant() ở
  // backend-cms/src/modules/inventory/inventory.service.ts, chỉ khác là lock nhiều dòng
  // 1 lúc thay vì 1 dòng.
  private async lockVariants(
    tx: Prisma.TransactionClient,
    variantIds: string[],
  ): Promise<Map<string, LockedVariant>> {
    const rows = await tx.$queryRaw<RawVariantRow[]>(Prisma.sql`
      SELECT id, "stockQuantity", price, sku, size, color, "productId"
      FROM "product_variants"
      WHERE id = ANY(${variantIds})
      ORDER BY id
      FOR UPDATE
    `);

    const products = await tx.product.findMany({
      where: { id: { in: [...new Set(rows.map((row) => row.productId))] } },
      select: { id: true, name: true, thumbnail: true },
    });
    const productById = new Map(products.map((p) => [p.id, p]));

    const result = new Map<string, LockedVariant>();
    for (const row of rows) {
      const product = productById.get(row.productId)!;
      result.set(row.id, {
        id: row.id,
        stockQuantity: row.stockQuantity,
        price: new Prisma.Decimal(row.price),
        sku: row.sku,
        size: row.size,
        color: row.color,
        productName: product.name,
        thumbnail: product.thumbnail,
      });
    }
    return result;
  }

  // Best-effort — gửi mail xác nhận không phải điều kiện để coi đơn hàng đã tạo thành
  // công. Không await ở call site (createOrder) để không làm chậm response chờ SMTP.
  private async sendConfirmationEmailBestEffort(
    userId: string,
    order: { orderCode: string; totalAmount: Prisma.Decimal },
  ): Promise<void> {
    try {
      const user = await this.prisma.user.findUniqueOrThrow({
        where: { id: userId },
        select: { email: true },
      });
      await this.mail.sendOrderConfirmationEmail(user.email, {
        orderCode: order.orderCode,
        totalAmount: order.totalAmount.toNumber(),
      });
    } catch (err) {
      this.logger.warn(
        `Không gửi được email xác nhận đơn hàng ${order.orderCode}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test orders.service.spec.ts`
Expected: PASS.

- [ ] **Step 5: Add address-not-owned test**

Append to the `describe('OrdersService.createOrder', ...)` block:
```ts
  it('địa chỉ không thuộc về user → NotFoundException', async () => {
    const { prisma, mail, addressFindUnique } = createMocks();
    addressFindUnique.mockResolvedValue(address({ userId: 'other-user' }));

    const service = new OrdersService(prisma, mail);

    await expect(service.createOrder('user-1', baseDto())).rejects.toThrow(
      NotFoundException,
    );
  });

  it('addressId không tồn tại → NotFoundException', async () => {
    const { prisma, mail, addressFindUnique } = createMocks();
    addressFindUnique.mockResolvedValue(null);

    const service = new OrdersService(prisma, mail);

    await expect(service.createOrder('user-1', baseDto())).rejects.toThrow(
      NotFoundException,
    );
  });
```

No implementation change needed — the guard clause from Step 3 already covers this. Run: `pnpm test orders.service.spec.ts` — expect both new tests PASS immediately.

- [ ] **Step 6: Add cart-item-not-owned test**

Append:
```ts
  it('cartItemIds chứa dòng không thuộc giỏ hàng của user → NotFoundException', async () => {
    const { prisma, mail, addressFindUnique, cartItemFindMany } = createMocks();
    addressFindUnique.mockResolvedValue(address());
    cartItemFindMany.mockResolvedValue([
      cartItem({
        id: 'item-1',
        productVariantId: 'variant-1',
        quantity: 2,
        cartUserId: 'other-user',
      }),
    ]);

    const service = new OrdersService(prisma, mail);

    await expect(service.createOrder('user-1', baseDto())).rejects.toThrow(
      NotFoundException,
    );
  });

  it('cartItemIds chứa id không tồn tại (giỏ hàng trả về ít hơn số id gửi lên) → NotFoundException', async () => {
    const { prisma, mail, addressFindUnique, cartItemFindMany } = createMocks();
    addressFindUnique.mockResolvedValue(address());
    cartItemFindMany.mockResolvedValue([]);

    const service = new OrdersService(prisma, mail);

    await expect(service.createOrder('user-1', baseDto())).rejects.toThrow(
      NotFoundException,
    );
  });
```

Run: `pnpm test orders.service.spec.ts` — expect both PASS immediately (guard clause already in place).

- [ ] **Step 7: Add preflight unavailable/out-of-stock test**

Append:
```ts
  it('sản phẩm ngừng bán hoặc không đủ hàng ở bước preflight → BadRequestException liệt kê đúng tên sản phẩm', async () => {
    const { prisma, mail, addressFindUnique, cartItemFindMany } = createMocks();
    addressFindUnique.mockResolvedValue(address());
    cartItemFindMany.mockResolvedValue([
      cartItem({
        id: 'item-1',
        productVariantId: 'variant-1',
        quantity: 2,
        status: ProductStatus.INACTIVE,
      }),
      cartItem({
        id: 'item-2',
        productVariantId: 'variant-2',
        quantity: 20,
        stockQuantity: 5,
      }),
    ]);

    const service = new OrdersService(prisma, mail);

    await expect(
      service.createOrder('user-1', baseDto({ cartItemIds: ['item-1', 'item-2'] })),
    ).rejects.toThrow('Sản phẩm không khả dụng hoặc không đủ hàng: Áo thun basic, Áo thun basic.');
  });
```

Run: `pnpm test orders.service.spec.ts` — expect PASS immediately (guard clause already in place).

- [ ] **Step 8: Add in-transaction race-condition test (stock changed between preflight and lock)**

Append:
```ts
  it('hết hàng phát hiện trong transaction (race condition) → ConflictException, không tạo đơn/trừ kho', async () => {
    const { prisma, mail, addressFindUnique, cartItemFindMany, queryRaw, productFindMany, orderCreate, stockMovementCreate } =
      createMocks();
    addressFindUnique.mockResolvedValue(address());
    cartItemFindMany.mockResolvedValue([
      cartItem({ id: 'item-1', productVariantId: 'variant-1', quantity: 2, stockQuantity: 10 }),
    ]);
    // Preflight thấy đủ hàng (10 >= 2), nhưng lúc lock trong transaction thì đã có đơn khác
    // mua trước, chỉ còn 1.
    queryRaw.mockResolvedValue([
      lockedRow({ id: 'variant-1', stockQuantity: 1, productId: 'product-1' }),
    ]);
    productFindMany.mockResolvedValue([
      { id: 'product-1', name: 'Áo thun basic', thumbnail: null },
    ]);

    const service = new OrdersService(prisma, mail);

    await expect(service.createOrder('user-1', baseDto())).rejects.toThrow(
      ConflictException,
    );
    expect(orderCreate).not.toHaveBeenCalled();
    expect(stockMovementCreate).not.toHaveBeenCalled();
  });
```

Run: `pnpm test orders.service.spec.ts` — expect PASS immediately (guard clause already in place).

- [ ] **Step 9: Add order-code collision retry test**

Append:
```ts
  it('trùng orderCode ở lần thử đầu → tự retry và tạo đơn thành công ở lần thử thứ 2', async () => {
    const { prisma, mail, addressFindUnique, cartItemFindMany, queryRaw, productFindMany, orderCreate } =
      createMocks();
    addressFindUnique.mockResolvedValue(address());
    cartItemFindMany.mockResolvedValue([
      cartItem({ id: 'item-1', productVariantId: 'variant-1', quantity: 1 }),
    ]);
    queryRaw.mockResolvedValue([
      lockedRow({ id: 'variant-1', stockQuantity: 10, productId: 'product-1' }),
    ]);
    productFindMany.mockResolvedValue([
      { id: 'product-1', name: 'Áo thun basic', thumbnail: null },
    ]);
    const collisionError = new Prisma.PrismaClientKnownRequestError('unique', {
      code: 'P2002',
      clientVersion: '6.19.3',
    });
    orderCreate
      .mockRejectedValueOnce(collisionError)
      .mockResolvedValueOnce({
        id: 'order-1',
        orderCode: 'DH20260820XYZ999',
        totalAmount: new Prisma.Decimal(150000),
        items: [],
      });

    const service = new OrdersService(prisma, mail);
    const result = await service.createOrder('user-1', baseDto());

    expect(result.id).toBe('order-1');
    expect(orderCreate).toHaveBeenCalledTimes(2);
  });
```

Run: `pnpm test orders.service.spec.ts` — expect PASS immediately (retry loop already in place from Step 3).

- [ ] **Step 10: Add exhausted-retries test**

Append:
```ts
  it('trùng orderCode cả 3 lần thử → ConflictException, không tạo đơn', async () => {
    const { prisma, mail, addressFindUnique, cartItemFindMany, queryRaw, productFindMany, orderCreate } =
      createMocks();
    addressFindUnique.mockResolvedValue(address());
    cartItemFindMany.mockResolvedValue([
      cartItem({ id: 'item-1', productVariantId: 'variant-1', quantity: 1 }),
    ]);
    queryRaw.mockResolvedValue([
      lockedRow({ id: 'variant-1', stockQuantity: 10, productId: 'product-1' }),
    ]);
    productFindMany.mockResolvedValue([
      { id: 'product-1', name: 'Áo thun basic', thumbnail: null },
    ]);
    const collisionError = new Prisma.PrismaClientKnownRequestError('unique', {
      code: 'P2002',
      clientVersion: '6.19.3',
    });
    orderCreate.mockRejectedValue(collisionError);

    const service = new OrdersService(prisma, mail);

    await expect(service.createOrder('user-1', baseDto())).rejects.toThrow(
      ConflictException,
    );
    expect(orderCreate).toHaveBeenCalledTimes(3);
  });
```

Run: `pnpm test orders.service.spec.ts` — expect PASS immediately (exhausted-retries branch already in place from Step 3).

- [ ] **Step 11: Add payment-method-restriction test**

Append:
```ts
  it('paymentMethod khác COD → BadRequestException, không gọi Prisma', async () => {
    const { prisma, mail, addressFindUnique } = createMocks();

    const service = new OrdersService(prisma, mail);

    await expect(
      service.createOrder('user-1', baseDto({ paymentMethod: PaymentProvider.VNPAY })),
    ).rejects.toThrow(BadRequestException);
    expect(addressFindUnique).not.toHaveBeenCalled();
  });
```

Run: `pnpm test orders.service.spec.ts` — expect PASS immediately (guard clause already in place).

- [ ] **Step 12: Run the full spec file one more time**

Run: `pnpm test orders.service.spec.ts`
Expected: all 11 tests PASS.

- [ ] **Step 13: Commit**

```bash
git add src/modules/orders/orders.service.ts src/modules/orders/orders.service.spec.ts
git commit -m "feat: implement OrdersService.createOrder"
```

---

### Task 7: `OrdersController` + `OrdersModule` wiring

**Repo:** `backend-user` (branch `feature/create-order-api`)

**Files:**
- Modify: `src/modules/orders/orders.controller.ts`
- Modify: `src/modules/orders/orders.module.ts`

**Interfaces:**
- Consumes: `OrdersService.createOrder` (Task 6), `CreateOrderDto` (Task 5), `JwtAuthGuard` (`../../common/guards/jwt-auth.guard`), `CurrentUser` (`../../common/decorators/current-user.decorator`), `AuthenticatedUser` (`../auth/strategies/jwt.strategy`), `MailModule` (`../mail/mail.module`).
- Produces: `POST /orders` route — consumed by Task 8 (e2e test).

- [ ] **Step 1: Update the controller**

`src/modules/orders/orders.controller.ts` (replace entire file contents):
```ts
import { Body, Controller, Post, UseGuards } from '@nestjs/common';
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
}
```

- [ ] **Step 2: Wire `MailModule` into `OrdersModule`**

`src/modules/orders/orders.module.ts` (replace entire file contents):
```ts
import { Module } from '@nestjs/common';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';
import { MailModule } from '../mail/mail.module';

@Module({
  imports: [MailModule],
  controllers: [OrdersController],
  providers: [OrdersService],
  exports: [OrdersService],
})
export class OrdersModule {}
```

- [ ] **Step 3: Verify it builds**

Run: `pnpm build`
Expected: succeeds — no test for this task alone (trivial wiring; exercised end-to-end by Task 8).

- [ ] **Step 4: Commit**

```bash
git add src/modules/orders/orders.controller.ts src/modules/orders/orders.module.ts
git commit -m "feat: wire OrdersController POST /orders route"
```

---

### Task 8: E2E test for the create-order flow

**Repo:** `backend-user` (branch `feature/create-order-api`)

**Files:**
- Create: `test/orders.e2e-spec.ts`

**Interfaces:**
- Consumes: `AppModule` (`../src/app.module`), `PrismaService`, `JwtService` (from `@nestjs/jwt`, registered by `AuthModule`), `JwtPayload` type (`../src/modules/auth/strategies/jwt.strategy`).

This test seeds its own data directly via `PrismaService` (there is no product-creation endpoint in `backend-user` — that's a `backend-cms`-only concern) and signs its own JWT (there is no existing e2e precedent in this repo to follow beyond the trivial `test/app.e2e-spec.ts`, which only calls `app.init()` without registering the global `ValidationPipe`/exception filter — this test registers them explicitly, mirroring `src/main.ts`, since `CreateOrderDto` validation must actually run).

- [ ] **Step 1: Write the e2e test**

`test/orders.e2e-spec.ts`:
```ts
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
    // Date.now() để không đụng dữ liệu seed thật và không tự đụng chính nó nếu lần chạy
    // trước bị crash giữa chừng trước khi afterAll dọn xong.
    const ghnSeed = Date.now();
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
```

- [ ] **Step 2: Run it against the local dev DB**

Run: `pnpm test:e2e orders.e2e-spec.ts`

Expected: both tests PASS. Requires the local dev DB to be reachable (same `DATABASE_URL` used by `pnpm start:dev`) and migrated to at least Task 1's migration (already true after Task 2's submodule bump + `pnpm prisma:generate`, since the migration was applied to the shared local DB when it was created in Task 1 — if using a separate DB for `backend-user` local dev, run `npx prisma migrate deploy --schema=vendor/backend-cms/prisma/schema.prisma` first to apply it there too).

- [ ] **Step 3: Commit**

```bash
git add test/orders.e2e-spec.ts
git commit -m "test: add e2e coverage for POST /orders"
```

---

### Task 9: Final verification

**Repo:** `backend-user` (branch `feature/create-order-api`)

- [ ] **Step 1: Lint**

Run: `pnpm lint`
Expected: 0 errors.

- [ ] **Step 2: Build**

Run: `pnpm build`
Expected: succeeds.

- [ ] **Step 3: Full unit test suite**

Run: `pnpm test`
Expected: all tests PASS, including `cart.service.spec.ts` (Task 3 regression check), `order-code.util.spec.ts`, `orders.service.spec.ts`.

- [ ] **Step 4: Full e2e suite**

Run: `pnpm test:e2e`
Expected: all tests PASS, including `app.e2e-spec.ts` and `orders.e2e-spec.ts`.

- [ ] **Step 5: Self-review against `CLAUDE.md`**

Re-read `backend-user/CLAUDE.md` and this plan's spec (`docs/superpowers/specs/2026-08-20-create-order-api-design.md`) side by side with the diff (`git diff fix-develop..feature/create-order-api`). Confirm: DTO has `@ApiProperty()` on every field (Task 5 ✓), controller has `@ApiTags`/`@ApiOperation` (Task 7 ✓), no `PrismaClient` constructed directly (all access via injected `PrismaService`/`tx` ✓), no secrets hardcoded, Orders module now has both unit and e2e tests as required.

- [ ] **Step 6: Do not push or open a PR**

Per this project's standing git workflow, stop here and let the user review before pushing either branch (`backend-cms:feature/order-item-snapshot-and-status-history`, `backend-user:feature/create-order-api`) or opening any PR.
