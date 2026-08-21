# Order Thank-You Page (BE) Design

> Nguồn: task "Trang cảm ơn hiển thị mã đơn hàng + gửi email xác nhận đơn cho khách
> (template email đơn hàng)" — BE, 0.5 điểm, phụ thuộc SMTP + API tạo đơn, ưu tiên Cao.

**Goal:** Bổ sung phần backend còn thiếu để trang cảm ơn (frontend-website, không thuộc
phạm vi lần này) có thể hiển thị đúng thông tin đơn hàng bất kỳ lúc nào (kể cả sau khi
reload/quay lại trang), và gửi email xác nhận đơn đầy đủ chi tiết thay vì chỉ mã đơn + tổng
tiền như hiện tại.

**Phạm vi:** Chỉ `backend-user`. Không đụng tới `frontend-website` (trang cảm ơn UI là task
riêng) hay `backend-cms`.

## Hiện trạng (đã có sẵn từ tính năng Create Order API)

- `POST /orders` đã trả `orderCode` trong response khi tạo đơn thành công.
- Gửi email xác nhận đơn (best-effort, không chặn response, lỗi gửi mail chỉ log warn) đã
  wiring sẵn qua `sendConfirmationEmailBestEffort()` trong `orders.service.ts`.
- Biến môi trường SMTP đã có sẵn trong `.env.example`.

## Phần còn thiếu — 2 việc cần làm

### 1. `GET /orders/:orderCode`

Trang cảm ơn cần đọc lại được đơn hàng bất kỳ lúc nào (F5, back, mở lại link đã lưu) —
không thể chỉ dựa vào response của `POST /orders` giữ trong state FE.

- Route mới trong `orders.controller.ts`: `GET /orders/:orderCode`, giữ nguyên
  `@UseGuards(JwtAuthGuard)` như route `POST` hiện có.
- Service `getOrderByCode(userId: string, orderCode: string)` trong `orders.service.ts`:
  - `prisma.order.findUnique({ where: { orderCode }, include: { items: true } })`.
  - Không tìm thấy **hoặc** `order.userId !== userId` → `NotFoundException('Không tìm thấy
    đơn hàng.')` (404) — giữ đúng pattern "không lộ thông tin tồn tại" đã dùng xuyên suốt
    module Orders (xem `createOrder()` — check địa chỉ/cart item cũng gộp 2 case này thành
    1 404 chung).
  - Trả về qua `toOrderResponse()` đã có sẵn (map `Prisma.Decimal` → `number` cho
    `totalAmount`/`priceAtPurchase`) — không viết mapper mới.

### 2. Email xác nhận đơn — bổ sung đầy đủ chi tiết

Hiện `sendConfirmationEmailBestEffort()` chỉ truyền `{ orderCode, totalAmount }` sang
`MailService.sendOrderConfirmationEmail()`. Dữ liệu còn thiếu (`items`, `shippingAddress`,
`paymentMethod`) **đã có sẵn** trên object `order` vừa tạo trong `createOrder()` — chỉ cần
truyền thêm qua, không cần query lại DB.

- `orders.service.ts`: mở rộng type tham số của `sendConfirmationEmailBestEffort()` từ
  `{ orderCode, totalAmount }` thành `OrderWithItems` (type đã có sẵn trong file), truyền
  thẳng `order` (kết quả `tx.order.create(...)`) thay vì object rút gọn.
- `mail.service.ts`: mở rộng chữ ký `sendOrderConfirmationEmail()` để nhận thêm
  `items: { productName, variantSku, size, color, quantity, priceAtPurchase }[]`,
  `shippingAddress: string`, `paymentMethod: PaymentProvider` (Decimal đã `.toNumber()` ở
  service trước khi truyền qua, giữ đúng nguyên tắc convert-tại-boundary đã áp dụng cho
  `toOrderResponse()`).
- `email.templates.ts` (`orderConfirmationEmailTemplate`): render thêm
  - Bảng sản phẩm: tên, size, màu, số lượng, đơn giá, thành tiền từng dòng.
  - Địa chỉ giao hàng (`shippingAddress`, đã là string format sẵn từ `createOrder()`).
  - Phương thức thanh toán — map `PaymentProvider.COD` → `"Thanh toán khi nhận hàng (COD)"`
    (inline, chỉ 1 giá trị vì hiện chỉ hỗ trợ COD, không cần tách util riêng).
  - Giữ nguyên mã đơn + tổng tiền đã có.

## Testing

- Unit test `getOrderByCode` (service): happy path, không tìm thấy (id sai), tìm thấy
  nhưng thuộc user khác (đều phải ra 404 case sau như case trước).
- Mở rộng `test/orders.e2e-spec.ts`: sau khi tạo đơn thành công, gọi
  `GET /orders/:orderCode` bằng đúng token → nhận đúng dữ liệu; gọi bằng token user khác →
  404; gọi `orderCode` không tồn tại → 404.
- Email template: unit test assertion đơn giản (không phải snapshot đầy đủ) kiểm tra HTML
  chứa đúng các trường mới (tên sản phẩm, địa chỉ, nhãn phương thức thanh toán) — không cần
  test gửi mail thật, cơ chế try/catch best-effort đã có sẵn và không đổi.

## Ngoài phạm vi (không làm lần này)

- UI trang cảm ơn thật (frontend-website) — task riêng.
- Hỗ trợ phương thức thanh toán khác ngoài COD.
- Đổi cơ chế gửi mail sang queue/retry — vẫn giữ best-effort try/catch như hiện tại.
