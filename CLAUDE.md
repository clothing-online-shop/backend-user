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

## Database (Prisma)

- Mọi thay đổi schema đi qua `prisma/schema.prisma` rồi chạy `pnpm --filter @clothing-shop/be prisma:migrate` (`prisma migrate dev --name <mo-ta-thay-doi>`) — không sửa tay migration đã áp dụng, không sửa DB trực tiếp qua pgAdmin cho thay đổi cấu trúc.
- Không import `@prisma/client` trực tiếp trong service để tạo `PrismaClient` mới — luôn inject `PrismaService` (đã được `PrismaModule` quản lý lifecycle connect/disconnect).
- Đặt tên bảng (`@@map`) theo snake_case số nhiều (`users`, `product_variants`) như đã có, giữ nhất quán khi thêm bảng mới.
- Quan hệ 1-nhiều/n-n phải có `@@index` trên khóa ngoại hay dùng (xem các model hiện tại làm mẫu).

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
3. Nếu đổi schema: đã tạo migration và test `prisma migrate dev` chạy sạch từ đầu (không chỉ chạy được trên máy đã có data cũ).
