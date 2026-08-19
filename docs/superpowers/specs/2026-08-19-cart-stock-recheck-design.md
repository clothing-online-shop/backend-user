# Thiết kế: Rà soát tồn kho giỏ hàng trước checkout

Ngày: 2026-08-19
Repo: backend-user

## Bối cảnh & phạm vi

Khách hàng có thể để sản phẩm trong giỏ hàng một thời gian trước khi checkout — trong lúc đó sản phẩm có thể hết hàng hoặc bị admin ngừng bán. Cần 1 API để FE chủ động gọi ngay trước khi vào bước thanh toán, rà soát toàn bộ giỏ hàng theo tồn kho/tình trạng bán hiện tại, tự sửa giỏ hàng (xóa/hạ số lượng) và báo cho khách biết đã có thay đổi gì.

Trong phạm vi: 1 endpoint mới trong module `cart` đã có sẵn (`CartService`/`CartController`), không cần schema mới, không cần module mới.

Ngoài phạm vi: không đụng `GET /cart` (giữ nguyên hành vi cũ, không tự động rà soát), không đụng luồng tạo đơn hàng (module `orders` vẫn là stub, ngoài phạm vi).

## Thiết kế

### Endpoint

`POST /cart/validate` — `@UseGuards(JwtAuthGuard)`, không cần body (thao tác trên giỏ hàng hiện tại của user, giống các endpoint khác trong module này).

### `CartService.validateCart(userId)`

Với mỗi dòng (`CartItem`) trong giỏ hàng hiện tại của user, kiểm tra theo đúng thứ tự:

1. `product.status !== ProductStatus.ACTIVE` (sản phẩm ngừng bán) → **xóa dòng khỏi giỏ**, ghi nhận `reason: 'unavailable'`. Cùng điều kiện `fetchActiveVariant`/`mergeCart` đã dùng — không tạo quy tắc riêng cho tính năng này.
2. `variant.stockQuantity === 0` (hết hàng hẳn) → **xóa dòng khỏi giỏ**, ghi nhận `reason: 'out_of_stock'`.
3. `variant.stockQuantity < item.quantity` (còn hàng nhưng không đủ số đang đặt) → **hạ `quantity` xuống đúng `variant.stockQuantity`**, ghi nhận `reason: 'capped'`.
4. Còn đủ hàng → giữ nguyên, không ghi vào danh sách thay đổi.

Response: `{ cart, adjustments }` — tái dùng `MergeAdjustment` (interface đã có trong `cart.service.ts`: `productVariantId`, `requestedQuantity`, `finalQuantity`, `reason`) và `toCartResponse`/`findMyCart` đã có sẵn, không định nghĩa lại type/format mới. `adjustments` rỗng ([]) nghĩa là giỏ hàng hợp lệ, an toàn để checkout — FE không cần field boolean riêng, tự suy ra từ mảng rỗng (đúng cách FE đã dùng cho `mergeCart`).

### Không thay đổi

- `findMyCart`, `addItem`, `updateItem`, `removeItem`, `mergeCart` — giữ nguyên logic hiện có.
- `GET /cart` — không tự động rà soát, vẫn trả nguyên trạng giỏ hàng như đang lưu.

## Việc cần làm

1. Thêm method `validateCart(userId: string)` vào `CartService` (`src/modules/cart/cart.service.ts`).
2. Thêm route `POST /cart/validate` vào `CartController` (`src/modules/cart/cart.controller.ts`).
3. Test: unit test cho `validateCart` — sản phẩm ngừng bán bị xóa, hết hàng bị xóa, không đủ số lượng bị hạ đúng số còn lại, còn đủ hàng giữ nguyên/không vào `adjustments`.
4. `pnpm --filter @clothing-shop/be lint` + `build` + `test` trước khi coi là xong.
