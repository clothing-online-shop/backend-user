# Thiết kế: Tính phí ship GHN theo địa chỉ + khối lượng đơn

Ngày: 2026-08-19
Repo: backend-user
Phụ thuộc: [backend-cms] `2026-08-19-ghn-shipping-schema-design.md` phải merge & deploy trước (đổi `Address` sang FK, thêm `ProductVariant.weight`), sau đó bump submodule `vendor/backend-cms` ở repo này.

## Bối cảnh & phạm vi

Tích hợp API GHN để phục vụ bước checkout: khách chọn 1 địa chỉ đã lưu, hệ thống tính phí ship dựa trên địa chỉ đó + tổng khối lượng giỏ hàng hiện tại, trả về danh sách gói cước khả dụng kèm thời gian giao dự kiến.

**Trong phạm vi**: mapping địa chỉ hành chính sang mã GHN, endpoint tính phí + gói cước + thời gian giao dự kiến.

**Ngoài phạm vi**: tạo vận đơn GHN thật, lưu phí ship/mã vận đơn vào `Order` (module `orders` vẫn là stub, không đụng tới trong spec này).

## Kiến trúc

### 1. `addresses` module — đổi sang id

`CreateAddressDto`/`UpdateAddressDto`: thay `province/district/ward: string` bằng `provinceId/districtId/wardId: string`. `AddressesService.createAddress`/`updateAddress` validate:
- `provinceId` tồn tại.
- `districtId` tồn tại **và** thuộc đúng `provinceId`.
- `wardId` tồn tại **và** thuộc đúng `districtId`.

Sai bất kỳ điều kiện nào → `BadRequestException` (không phải `NotFoundException`, vì đây là lỗi input của chính request, không phải tra cứu theo id ở URL — khác pattern `findOwned`). Logic validate 3 cấp này giống hệt cách `LocationsService` bên `backend-cms` validate `findDistricts`/`findWards`, viết lại ở đây vì không share code giữa 2 repo (chỉ share schema qua submodule).

### 2. Module `locations` mới — đọc, public

```
src/modules/locations/
├── locations.module.ts
├── locations.controller.ts
├── locations.service.ts
└── dto/
    ├── list-districts-query.dto.ts
    └── list-wards-query.dto.ts
```

- `GET /locations/provinces`
- `GET /locations/districts?provinceId=`
- `GET /locations/wards?districtId=`

Đọc thẳng bảng `Province/District/Ward` (đã có sẵn qua schema dùng chung, do `backend-cms` đồng bộ). **Không** có route `/sync` (đặc quyền admin, giữ nguyên bên `backend-cms`). **Không** guard `JwtAuthGuard` — dữ liệu hành chính công khai, không nhạy cảm, cần hiển thị được ở form địa chỉ kể cả trước khi có UI yêu cầu login. Tái sử dụng logic tương tự `LocationsService.findProvinces/findDistricts/findWards` bên CMS (không import chéo giữa 2 repo — viết lại tương ứng ở đây).

### 3. `GhnClient` — client GHN riêng cho repo này

```
src/common/ghn/ghn-client.service.ts
```

Copy pattern từ `backend-cms/src/common/ghn/ghn-client.service.ts` (header `Token`, base URL qua `ConfigService`, log lỗi server-side không lộ ra response). Khác biệt: API tính phí/leadtime của GHN còn cần header `ShopId` (master-data sync bên CMS không cần) — client này thêm header đó.

Biến môi trường mới (thêm vào `.env.example`):

```
GHN_API_TOKEN=""
GHN_API_BASE_URL="https://dev-online-gateway.ghn.vn/shiip/public-api"
GHN_SHOP_ID=""
GHN_FROM_DISTRICT_ID=""
GHN_FROM_WARD_CODE=""
```

`GHN_FROM_DISTRICT_ID`/`GHN_FROM_WARD_CODE` là địa chỉ kho/gửi hàng cố định của shop (điểm `from` khi tính phí) — 1 shop 1 kho, không cần cấu hình động trong DB ở giai đoạn này.

### 4. Module `shipping` mới

```
src/modules/shipping/
├── shipping.module.ts
├── shipping.controller.ts
├── shipping.service.ts
└── dto/
    └── shipping-fee-query.dto.ts
```

**Endpoint**: `GET /shipping/fee?addressId=xxx`, `@UseGuards(JwtAuthGuard)` (cùng pattern `cart`/`addresses` — checkout luôn yêu cầu đăng nhập, giỏ hàng chỉ tồn tại theo user đã login, không có guest cart).

**`ShippingService.getFeeQuote(userId, addressId)`**:

1. Lấy địa chỉ theo `addressId`, kèm `province/district/ward` (để lấy `ghnId`/`ghnCode`) — 404 nếu không tồn tại hoặc không thuộc `userId` (tái dùng pattern `findOwned` như `AddressesService`).
2. Lấy giỏ hàng hiện tại của `userId` (join `productVariant` lấy `weight`).
   - Giỏ rỗng → `BadRequestException('Giỏ hàng trống, không thể tính phí ship.')`.
   - Có variant nào `weight === null` → `BadRequestException` liệt kê tên các sản phẩm thiếu khối lượng (ví dụ: `Sản phẩm "Áo thun basic" chưa có thông tin khối lượng, không thể tính phí ship.`) — không tính phí bằng số giả.
   - Tổng khối lượng = `Σ (variant.weight * quantity)`.
3. Gọi GHN `POST /v2/shipping-order/available-services` với `shop_id`, `from_district`, `to_district` → danh sách `{ service_id, service_type_id, short_name }` khả dụng cho tuyến này.
4. Với mỗi gói ở bước 3, gọi song song (`Promise.all` — chỉ vài gói/lần, không cần giới hạn concurrency như `LocationsService.syncFromGhn` xử lý hàng nghìn request):
   - `POST /v2/shipping-order/fee` (`service_id`/`service_type_id`, `from_district_id`, `from_ward_code`, `to_district_id`, `to_ward_code`, `weight`) → phí.
   - `POST /v2/shipping-order/leadtime` (cùng tham số tuyến + `service_id`) → thời gian giao dự kiến (`leadtime`, timestamp Unix GHN trả về).
5. Trả mảng, sắp theo phí tăng dần:

```ts
{
  serviceId: number;
  serviceTypeId: number;
  name: string;
  fee: number;
  expectedDeliveryTime: string; // ISO, convert từ leadtime (Unix) của GHN
}[]
```

**Lỗi gọi GHN** (network, GHN trả lỗi ở bất kỳ bước 3–4 nào) → `InternalServerErrorException('Không tính được phí ship, vui lòng thử lại.')`, log chi tiết lỗi server-side (theo đúng pattern `GhnClient` hiện có, không lộ raw error cho client).

## Test

Unit test `ShippingService` (mock `GhnClient`, `PrismaService`):
- Happy path: nhiều gói cước trả về, sort đúng theo phí.
- Giỏ hàng trống → 400.
- Variant thiếu weight → 400, message nêu đúng tên sản phẩm.
- `addressId` không tồn tại / không thuộc user → 404.
- `GhnClient` throw lỗi → 500, không lộ chi tiết.

Không bắt buộc theo rule "Auth/Orders/Payments" ở `CLAUDE.md` (shipping không phải 1 trong 3 module đó), nhưng viết test vì đây là logic tính tiền hiển thị cho khách — sai sót ảnh hưởng trực tiếp trải nghiệm checkout.

## Việc cần làm

1. Bump `vendor/backend-cms` lên commit đã có schema mới (spec backend-cms), `pnpm prisma:generate`.
2. Sửa `addresses` module: DTO + validate 3 cấp id.
3. Thêm module `locations` (đọc, public).
4. Thêm `GhnClient` + biến môi trường (`.env.example`).
5. Thêm module `shipping` (service + controller + DTO query).
6. Viết unit test `shipping.service.spec.ts`.
7. `pnpm --filter @clothing-shop/be lint` + `build` + `test` trước khi mở PR (theo `CLAUDE.md`).
