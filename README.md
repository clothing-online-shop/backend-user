# backend-user

Backend API phục vụ **khách hàng** cho hệ thống Clothing Shop — được `frontend-website` gọi trực tiếp. Đây là 1 trong 4 repo độc lập của hệ thống (không còn là monorepo/workspace chung):

| Repo | Vai trò | Port local |
|---|---|---|
| **backend-user** (repo này) | API công khai cho khách hàng | `3001` |
| [backend-cms](https://github.com/clothing-online-shop/backend-cms) | API quản trị cho admin | `3002` |
| [frontend-website](https://github.com/clothing-online-shop/frontend-website) | Website bán hàng (Next.js) | `3000` |
| [frontend-admin](https://github.com/clothing-online-shop/frontend-admin) | Trang quản trị (Vite + React) | `5173` |

`backend-user` và `backend-cms` dùng **chung một database PostgreSQL** (khác vai trò, khác cổng, khác `JWT_SECRET`, nhưng cùng schema/dữ liệu).

## Tech stack

- NestJS 11 + TypeScript
- Prisma ORM + PostgreSQL
- Redis (ioredis) — cache/session phụ trợ
- Passport JWT (access + refresh token) — hash mật khẩu bằng `argon2`
- class-validator / class-transformer cho DTO
- Swagger (`@nestjs/swagger`) tự sinh doc tại `/api/docs`
- nestjs-pino cho log có cấu trúc

## Module & route hiện có

Chỉ giữ lại phần dành cho khách hàng — mọi thao tác quản trị (CUD sản phẩm/danh mục, upload ảnh, CMS banner/blog) nằm bên `backend-cms`.

| Module | Route | Ghi chú |
|---|---|---|
| `auth` | `POST /auth/register` | Đăng ký tài khoản khách (role mặc định `CUSTOMER`) |
| | `POST /auth/login` | Đăng nhập, trả `accessToken` + `refreshToken` |
| | `POST /auth/refresh` | Cấp lại token từ refresh token |
| | `POST /auth/forgot-password`, `POST /auth/reset-password` | Quên/đặt lại mật khẩu (dev: log link ra console) |
| | `GET /auth/me` | Thông tin user hiện tại (cần Bearer token) |
| `categories` | `GET /categories`, `GET /categories/:slug` | Chỉ trả danh mục đang `isActive` — không có route tạo/sửa/xóa. Ẩn 1 danh mục cha (`isActive = false`) sẽ ẩn cascade toàn bộ danh mục con bên dưới, kể cả khi con vẫn `isActive = true` — áp dụng cho cả cây (`GET /categories`) lẫn truy cập trực tiếp bằng slug (`GET /categories/:slug`) |
| `products` | `GET /products`, `GET /products/:slug` | Luôn lọc `status = ACTIVE`, hỗ trợ filter theo category/giá/size/màu/search/sort/phân trang. Lọc theo `category` cũng cascade theo `isActive`: sản phẩm thuộc danh mục con đang ẩn (hoặc con của danh mục cha đang ẩn) không xuất hiện khi lọc theo danh mục cha |
| `users` | *(chưa có route)* | Scaffold cho tính năng profile/sổ địa chỉ, sẽ triển khai sau |
| `cart` | *(chưa có route)* | Scaffold giỏ hàng, triển khai sau |
| `orders` | *(chưa có route)* | Scaffold tạo đơn + xem đơn của chính user đăng nhập, triển khai sau |
| `payments` | *(chưa có route)* | Scaffold webhook thanh toán, triển khai sau |

> Các module còn là scaffold (`cart`, `orders`, `payments`, `users`) chưa có logic nghiệp vụ — khi triển khai thật, nhớ nguyên tắc: route "xem đơn của tôi" phải lọc `where: { userId: currentUser.id }` để không lộ dữ liệu người khác.

## Yêu cầu môi trường

- Node.js 22+, `pnpm` (cài qua `npm i -g pnpm` nếu chưa có)
- PostgreSQL 16 + Redis 7 chạy local — có 2 cách, chọn 1:
  - **Docker**: `docker compose up -d` ngay trong thư mục này (đã có `docker-compose.yml`, dùng chung cho cả `backend-cms`)
  - **Cài native (không có Docker)**: dùng Postgres/Redis cài qua Scoop hoặc cài trực tiếp, chỉ cần khớp `DATABASE_URL`/`REDIS_URL` trong `.env`

## Cài đặt & chạy local

```bash
# 1. Cài dependency (độc lập, không chạy từ thư mục cha)
pnpm install

# 2. Tạo .env từ mẫu, chỉnh nếu cần
cp .env.example .env

# 3. Khởi động Postgres/Redis (xem "Yêu cầu môi trường")
docker compose up -d

# 4. Sinh Prisma Client — KHÔNG chạy migrate ở đây (xem phần Prisma bên dưới)
pnpm prisma:generate

# 5. Chạy dev server (watch mode)
pnpm dev
```

Server chạy ở `http://localhost:3001`, Swagger docs tại `http://localhost:3001/api/docs`, health check tại `http://localhost:3001/health`.

## Biến môi trường (`.env`)

| Biến | Mô tả |
|---|---|
| `DATABASE_URL` | Kết nối Postgres — **phải trỏ cùng database với `backend-cms`** |
| `REDIS_URL` | Kết nối Redis |
| `JWT_SECRET`, `JWT_REFRESH_SECRET` | Secret ký JWT — **khác với `backend-cms`** để token 2 bên không dùng chéo được |
| `JWT_ACCESS_EXPIRES_IN`, `JWT_REFRESH_EXPIRES_IN` | Thời hạn token (mặc định `15m` / `7d`) |
| `PORT` | Mặc định `3001` |
| `WEB_ORIGIN` | Origin của `frontend-website` được phép gọi CORS (mặc định `http://localhost:3000`) |
| `CLOUDINARY_*` | *(không dùng ở backend này — upload ảnh chỉ có ở backend-cms)* |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM` | Cấu hình gửi email (quên mật khẩu, chào mừng khi đăng ký). Để trống thì `MailService` tự fallback log ra console thay vì gửi thật — không bắt buộc ở dev local |
| `SENTRY_DSN` | DSN của Sentry để forward lỗi 5xx — để trống thì bỏ qua, không bắt buộc ở dev local |

## Prisma — ai chạy migration?

**Chỉ `backend-cms` được chạy `prisma migrate dev`.** Backend này chỉ chạy `pnpm prisma:generate` để sinh lại Prisma Client theo schema mới nhất. Lý do: 2 backend trỏ chung 1 database, nếu cả 2 cùng tạo migration độc lập sẽ dễ lệch lịch sử migration.

Quy trình khi cần đổi schema:
1. Sửa `prisma/schema.prisma` **ở `backend-cms`**, chạy `prisma migrate dev --name <mo-ta>` bên đó.
2. Copy `prisma/schema.prisma` + thư mục `prisma/migrations` mới sang `backend-user`.
3. Ở `backend-user`, chạy `pnpm prisma:generate` (không migrate).

## Scripts

| Lệnh | Mô tả |
|---|---|
| `pnpm dev` | Chạy dev server (watch mode) |
| `pnpm build` | Build production (`dist/`) |
| `pnpm start:prod` | Chạy bản đã build |
| `pnpm lint` | ESLint (`--fix`) |
| `pnpm test`, `pnpm test:e2e` | Unit test / e2e test |
| `pnpm prisma:generate` | Sinh Prisma Client |
| `pnpm seed` | Chạy `prisma/seed.ts` (seed categories/products/admin — **chỉ nên chạy 1 lần từ 1 trong 2 backend** vì chung DB) |

## Tài khoản test có sẵn (sau khi seed)

| Email | Mật khẩu | Role |
|---|---|---|
| `admin@clothing-shop.com` | `admin123` | ADMIN *(không đăng nhập được ở backend-user, chỉ dùng ở backend-cms)* |

Đăng ký tài khoản khách mới qua `POST /auth/register` hoặc form `/register` trên `frontend-website`.
