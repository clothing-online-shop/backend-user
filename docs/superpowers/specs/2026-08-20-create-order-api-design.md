# API tạo đơn hàng (Create Order)

**Repo:** `backend-user` (logic nghiệp vụ) + `backend-cms` (schema, qua submodule `vendor/backend-cms`)
**Ngày:** 2026-08-20

## 1. Bối cảnh & mục tiêu

Module `orders` (`backend-user/src/modules/orders/`) hiện chỉ là stub rỗng (`OrdersService {}`). Cần triển khai API tạo đơn hàng với 5 yêu cầu:

1. Sinh mã đơn hàng.
2. Snapshot giá & thông tin sản phẩm tại thời điểm đặt (không đổi sau này dù admin sửa/xoá sản phẩm).
3. Trừ tồn kho.
4. Đặt trạng thái ban đầu `PENDING` ("Chờ xác nhận").
5. Ghi lịch sử trạng thái đơn hàng.

## 2. Ngoài phạm vi (out of scope)

- Tích hợp cổng thanh toán online (VNPAY/MOMO/STRIPE) — chỉ hỗ trợ `COD`, `paymentStatus` luôn `UNPAID` khi tạo. Module `payments` vẫn là stub, việc tích hợp gateway để sau.
- Áp mã giảm giá (`Coupon`) — schema `Order` hiện không có field liên quan, không thêm trong lần này.
- Tính phí vận chuyển GHN — `Order` không có field `shippingFee`, `totalAmount` chỉ là tổng tiền hàng.
- Các API khác của module orders (xem chi tiết đơn, huỷ đơn, cập nhật trạng thái, danh sách đơn) — chỉ làm `POST /orders`.

## 3. Thay đổi schema (`backend-cms`)

### 3.1. `OrderItem` — thêm cột snapshot

```prisma
model OrderItem {
  id               String  @id @default(cuid())
  orderId          String
  productVariantId String
  productName      String   // snapshot — tên SP tại thời điểm đặt
  variantSku       String   // snapshot — SKU biến thể
  size             String   // snapshot
  color            String   // snapshot
  thumbnail        String?  // snapshot — ảnh SP tại thời điểm đặt
  quantity         Int
  priceAtPurchase  Decimal  @db.Decimal(12, 2)

  order          Order          @relation(fields: [orderId], references: [id], onDelete: Cascade)
  productVariant ProductVariant @relation(fields: [productVariantId], references: [id], onDelete: Restrict)

  @@index([orderId])
  @@map("order_items")
}
```

`onDelete: Restrict` cho `productVariant` (đổi từ mặc định) — giống lý do đã áp dụng cho `StockMovement`: biến thể đã có trong đơn hàng không được xoá cứng, tránh mất dữ liệu snapshot tham chiếu.

### 3.2. `OrderStatusHistory` — bảng mới

```prisma
model OrderStatusHistory {
  id          String       @id @default(cuid())
  orderId     String
  fromStatus  OrderStatus?  // null = dòng đầu tiên khi tạo đơn
  toStatus    OrderStatus
  note        String?
  changedById String?      // null = hệ thống tự ghi (lúc tạo đơn)
  createdAt   DateTime     @default(now())

  order     Order  @relation(fields: [orderId], references: [id], onDelete: Cascade)
  changedBy User?  @relation(fields: [changedById], references: [id])

  @@index([orderId])
  @@map("order_status_histories")
}
```

Thêm quan hệ ngược `statusHistories OrderStatusHistory[]` vào `Order` và `orderStatusChanges OrderStatusHistory[]` vào `User`.

### 3.3. Triển khai schema

Thực hiện ở `backend-cms` (nhánh riêng): sửa `prisma/schema.prisma`, chạy `prisma migrate dev --name add_order_item_snapshot_and_status_history`. Sau khi merge/deploy, bên `backend-user` bump submodule (`cd vendor/backend-cms && git fetch && git checkout <commit-mới> && cd ../.. && git add vendor/backend-cms && pnpm prisma:generate`) theo đúng quy trình đã ghi trong `backend-user/CLAUDE.md`.

## 4. API contract (`backend-user`)

`POST /orders` — yêu cầu JWT (`@UseGuards(JwtAuthGuard)`), `@ApiTags('orders')`.

### Request DTO

```ts
class CreateOrderDto {
  @IsString() @IsNotEmpty()
  addressId: string;

  @IsArray() @ArrayMinSize(1) @IsString({ each: true })
  cartItemIds: string[];

  @IsEnum(PaymentProvider)
  paymentMethod: PaymentProvider; // validate strict, nhưng chỉ chấp nhận COD ở tầng service — xem mục 6
}
```

### Response 201

```ts
{
  id: string;
  orderCode: string;
  status: 'PENDING';
  totalAmount: number;
  shippingAddress: string; // đã format từ Address snapshot
  paymentMethod: string;
  paymentStatus: 'UNPAID';
  items: {
    productVariantId: string;
    productName: string;
    variantSku: string;
    size: string;
    color: string;
    thumbnail: string | null;
    quantity: number;
    priceAtPurchase: number;
  }[];
  createdAt: string;
}
```

## 5. Luồng xử lý (`OrdersService.createOrder(userId, dto)`)

### Bước 1 — Preflight (ngoài transaction, trả lỗi rõ ràng nhanh)

1. Lấy `Address` theo `addressId` + `userId` — không thuộc về user hoặc không tồn tại → `NotFoundException`.
2. Lấy các `CartItem` theo `cartItemIds` kèm `productVariant.product`, kiểm tra toàn bộ thuộc giỏ hàng của `userId` (gộp "không tìm thấy" + "không phải của mình" thành 1 lỗi 404, theo đúng cách `findOwnedItem` trong `cart.service.ts` đang làm) — thiếu bất kỳ id nào → `NotFoundException`.
3. Với từng dòng: kiểm tra `isProductAvailable` (chuyển hàm này từ `cart.service.ts` sang `src/common/utils/product-availability.util.ts` vì giờ dùng ở ≥ 2 module, đúng rule trong `CLAUDE.md`) và `stockQuantity >= quantity`. Gom **toàn bộ** lỗi thay vì dừng ở dòng đầu tiên → `BadRequestException` liệt kê rõ từng sản phẩm hết hàng/ngừng bán.

### Bước 2 — Sinh mã đơn

`orderCode = "DH" + yyyyMMdd + 6 ký tự random (A-Z0-9, viết hoa)`. Không query kiểm tra tồn tại trước (không an toàn với race) — dựa vào ràng buộc `@unique` ở DB, bắt lỗi Prisma `P2002` trên field `orderCode` trong transaction và retry tối đa 3 lần với mã mới; hết 3 lần vẫn đụng → `ConflictException`.

### Bước 3 — Transaction atomic (theo đúng pattern `lockVariant`/`applyMovement` đã có ở `backend-cms/src/modules/inventory/inventory.service.ts`)

1. Lock từng `ProductVariant` liên quan bằng `SELECT ... FOR UPDATE` (raw query), **theo thứ tự `id` tăng dần** (sort danh sách trước khi lock) — đảm bảo 2 đơn hàng chứa chung sản phẩm không lock chéo thứ tự khác nhau, tránh deadlock.
2. Re-check `stockQuantity >= quantity` trên dữ liệu vừa lock (phòng trường hợp có đơn khác mua giữa lúc preflight và lúc vào transaction) — không đủ → `ConflictException` (409 — do state đổi giữa chừng, không phải lỗi input ban đầu).
3. Với từng dòng: tạo `StockMovement` (`type: EXPORT`, `quantity: -qty`, `createdById: null` — hệ thống tự trừ, không phải admin thao tác tay) + `productVariant.update({ stockQuantity: { decrement: qty } })`.
4. Tạo `Order` kèm `items: { create: [...] }` — snapshot `productName`/`variantSku`/`size`/`color`/`thumbnail`/`priceAtPurchase` lấy từ **variant đã lock ở bước 1** (không lấy lại từ `CartItem` ban đầu, vì dữ liệu đó có thể đã cũ tại thời điểm này). `status: PENDING`, `paymentStatus: UNPAID`, `shippingAddress` = chuỗi format từ `Address` (lấy ở bước preflight, kèm `province`/`district`/`ward` qua include): `"{receiverName} - {phone} - {detail}, {ward.name}, {district.name}, {province.name}"`.
5. Tạo `OrderStatusHistory` đầu tiên: `{ fromStatus: null, toStatus: PENDING, changedById: null }`.
6. `cartItem.deleteMany({ where: { id: { in: cartItemIds } } })`.

### Bước 4 — Sau khi transaction commit (best-effort)

Gọi `mailService.sendOrderConfirmationEmail(user.email, { orderCode, totalAmount })` (method đã có sẵn trong `mail.service.ts`) trong `try/catch` riêng — log lỗi nếu gửi thất bại, **không** throw hay rollback đơn. Đơn đã tạo thành công trong DB là điều quan trọng nhất; gửi mail thất bại không phải lỗi nghiệp vụ.

## 6. Xử lý lỗi

| Tình huống | Exception |
|---|---|
| `addressId` không tồn tại / không thuộc user | `NotFoundException` |
| `cartItemIds` rỗng hoặc chứa id không thuộc giỏ hàng của user | `BadRequestException` / `NotFoundException` |
| Sản phẩm ngừng bán / hết hàng (phát hiện ở preflight) | `BadRequestException`, liệt kê từng sản phẩm |
| `paymentMethod` khác `COD` | `BadRequestException` (chặn ở tầng service, DTO chỉ validate đúng enum `PaymentProvider`, không giới hạn — chặn nghiệp vụ để dễ mở rộng sau này) |
| Hết hàng phát hiện trong transaction (race condition thật sự) | `ConflictException` |
| Trùng `orderCode` sau 3 lần retry | `ConflictException` |

Không tự bắt lỗi để format response thủ công trong controller/service — để `AllExceptionsFilter` global xử lý theo đúng quy ước sẵn có.

## 7. Testing (bắt buộc — Orders là module phải có test theo `CLAUDE.md`)

**Unit (`orders.service.spec.ts`, mock `PrismaService`):**
- Tạo đơn thành công → đúng snapshot, đúng số lượng tồn kho bị trừ, `OrderStatusHistory` được tạo với `toStatus: PENDING`, `CartItem` liên quan bị xoá.
- `addressId` không thuộc user → `NotFoundException`.
- `cartItemIds` chứa id không thuộc giỏ hàng của user → `NotFoundException`.
- Sản phẩm hết hàng/ngừng bán ở bước preflight → `BadRequestException`, message liệt kê đúng sản phẩm.
- `paymentMethod` khác `COD` → `BadRequestException`.
- Trùng `orderCode` lần đầu, retry thành công lần 2 → đơn vẫn được tạo.

**E2E (`orders.e2e-spec.ts`):**
- Luồng chính: đăng nhập → thêm sản phẩm vào giỏ → tạo địa chỉ → gọi `POST /orders` → kiểm tra response 201, `stockQuantity` của variant giảm đúng trong DB, có bản ghi `StockMovement` và `OrderStatusHistory`, giỏ hàng không còn các dòng vừa mua.
- Gọi lại `POST /orders` với cùng `cartItemIds` đã bị xoá khỏi giỏ → `NotFoundException` (giỏ không còn dòng đó).

## 8. Các quyết định đã chốt (tham khảo nhanh)

- Đơn hàng tạo từ giỏ hàng (`cartItemIds`), không hỗ trợ "mua ngay" gửi thẳng danh sách sản phẩm trong lần này.
- Địa chỉ giao hàng: client gửi `addressId` có sẵn trong sổ địa chỉ, server tự format thành chuỗi snapshot lưu vào `Order.shippingAddress`.
- Snapshot sản phẩm: thêm cột mới vào `OrderItem` (không lấy live qua join).
- Lịch sử trạng thái: bảng riêng `OrderStatusHistory`, không dùng chung `AuditLog`.
- Thanh toán: chỉ hỗ trợ `COD` trong lần này.
