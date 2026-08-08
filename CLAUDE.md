# Backend (apps/be) — Quy tắc & Chuẩn code

NestJS + TypeScript + Prisma + PostgreSQL + Redis. API dùng chung cho `apps/web` và `apps/cms`.

## Cấu trúc module (bắt buộc theo mẫu)

Mỗi tính năng là 1 thư mục dưới `src/modules/<ten-module>/`:

```
src/modules/<ten-module>/
├── <ten-module>.module.ts
├── <ten-module>.controller.ts
├── <ten-module>.service.ts
├── dto/                # request/response DTO, 1 file/DTO
└── strategies/          # nếu có passport strategy riêng
```

- Không tạo controller/service dùng chung nhiều nghiệp vụ khác nhau — 1 module = 1 domain (products, orders, payments...).
- Logic nghiệp vụ nằm ở `*.service.ts`. Controller chỉ nhận request, gọi service, trả response — không xử lý logic trong controller.
- Muốn dùng service của module khác: `imports` module đó + đảm bảo `exports` service cần dùng (xem `UsersModule` export `UsersService` để `AuthModule` dùng).
- Đặt tên file/thư mục kebab-case, tên class PascalCase (`ProductsService`, `products.service.ts`).

## DTO & Validation

- Mọi input từ client phải có DTO riêng trong `dto/`, dùng `class-validator` decorator (`@IsEmail`, `@IsString`, `@MinLength`...).
- Luôn thêm `@ApiProperty()` (từ `@nestjs/swagger`) cho từng field để Swagger tự sinh doc — không viết doc tay.
- Không tắt `whitelist`/`forbidNonWhitelisted` của `ValidationPipe` (đang bật global ở `main.ts`) — nghĩa là field thừa trong body sẽ bị từ chối, đây là chủ đích, không phải bug.

## Xử lý lỗi

- Ném `HttpException` con cháu chuẩn của Nest (`BadRequestException`, `ConflictException`, `UnauthorizedException`, `NotFoundException`...), không tự tạo response lỗi thủ công trong controller.
- `AllExceptionsFilter` (global) đã format lỗi thành `{ statusCode, message, error, timestamp, path }` — không cần catch lại ở controller/service để format response.
- Không để lộ message lỗi nội bộ (stack trace, câu lệnh SQL...) ra response cho client.

## Auth & phân quyền

- Route cần đăng nhập: gắn `@UseGuards(JwtAuthGuard)`.
- Route cần giới hạn theo role: thêm `@Roles(UserRole.ADMIN)` + `@UseGuards(JwtAuthGuard, RolesGuard)`.
- Lấy user hiện tại trong handler bằng `@CurrentUser() user: AuthenticatedUser`, không tự parse lại JWT trong controller.
- Không bao giờ trả field `password` ra response — xem cách `auth.service.ts` dùng `toSafeUser()` để loại bỏ trước khi trả về.
- Mật khẩu luôn hash bằng `argon2` (`argon2.hash` / `argon2.verify`), không tự viết hàm hash khác, không lưu plaintext dù chỉ tạm thời (kể cả trong log).

## Database (Prisma) — schema dùng chung với `backend-cms`

`backend-user` và `backend-cms` cùng ghi/đọc **1 Postgres duy nhất**. Để tránh lệch schema (đã từng gây lỗi 500 `type "public.ProductStatus" does not exist` trên UAT khi `backend-cms` đổi cấu trúc bảng mà `backend-user` không biết), `backend-user` **không tự khai báo `prisma/schema.prisma` hay migration riêng nữa**. Toàn bộ schema thật nằm trong git submodule `vendor/backend-cms` (trỏ vào repo `backend-cms`), là nơi duy nhất sở hữu migration và chạy `prisma migrate deploy`.

- Sau khi `git clone`/`git pull` repo này: chạy `git submodule update --init --recursive` để lấy schema (không tự động).
- `pnpm prisma:generate` / `pnpm prisma:studio` / `pnpm seed` đều đã trỏ sẵn `--schema=vendor/backend-cms/prisma/schema.prisma` trong `package.json` — không tự thêm schema riêng ở `backend-user`.
- **Không bao giờ đổi cấu trúc bảng (thêm/sửa model) từ phía `backend-user`** — mọi thay đổi schema dùng chung phải làm ở repo `backend-cms`. Khi `backend-cms` đổi schema và đã deploy:
  ```
  cd vendor/backend-cms && git fetch && git checkout <commit-mới-trên-develop> && cd ../..
  git add vendor/backend-cms
  pnpm prisma:generate
  # build/test lại, sửa code nếu field/model đổi, rồi commit + push
  ```
- Không import `@prisma/client` trực tiếp trong service để tạo `PrismaClient` mới — luôn inject `PrismaService` (đã được `PrismaModule` quản lý lifecycle connect/disconnect).
- DB không còn dùng Postgres enum cho các cột trạng thái dạng số (ví dụ `Product.status`) — dùng enum TS cục bộ mirror giá trị (xem `src/modules/products/product-status.enum.ts`), không import enum trạng thái từ `@prisma/client`.

## Cấu hình & bí mật

- Không hardcode secret/connection string trong code — luôn qua `ConfigService.get()` với giá trị mặc định hợp lý cho dev (xem `auth.module.ts`, `redis.module.ts`).
- Thêm biến môi trường mới → phải thêm luôn vào `.env.example` (không thêm giá trị thật/nhạy cảm vào file `.example`).
- `.env` thật không commit (đã có trong `.gitignore` ở root).

## Response & API contract

- Mọi controller mới phải gắn `@ApiTags('<ten-domain>')` ở class và `@ApiOperation({ summary: '...' })` ở từng method — Swagger (`/api/docs`) là nguồn contract để 2 FE code song song, phải luôn đúng và đầy đủ.
- Endpoint cần trả 200 thay vì 201 mặc định (POST không tạo resource, ví dụ login) → thêm `@HttpCode(HttpStatus.OK)`.

## Test

- Auth, Orders, Payments là 3 module bắt buộc phải có test (unit cho service, e2e cho luồng chính) trước khi coi là "xong" — đây là các luồng liên quan tiền/đơn hàng, lỗi ở đây ảnh hưởng trực tiếp khách hàng.
- Chạy `pnpm --filter @clothing-shop/be test` trước khi coi 1 module là hoàn thành.

## Trước khi mở PR

1. `pnpm --filter @clothing-shop/be lint` — 0 lỗi.
2. `pnpm --filter @clothing-shop/be build` — build qua.
3. Nếu bump submodule `vendor/backend-cms` lên commit mới: đã `pnpm prisma:generate` lại và build/test qua với schema mới.
