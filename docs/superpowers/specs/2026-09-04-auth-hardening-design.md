# Auth Hardening (backend-user) — Design

> Nguồn: rà soát bảo mật 4 luồng auth (đăng ký, xác thực OTP, quên mật khẩu, đổi mật
> khẩu) trên `backend-user`. Mục tiêu: đưa auth về mức baseline "chuẩn thực tế + bảo mật
> cơ bản" (tương đương OWASP ASVS Level 1).

**Phạm vi:** Chỉ `backend-user`. **Không đổi schema Prisma** (`emailVerifiedAt`, `status`
đã có sẵn trong `vendor/backend-cms`) → không bump submodule. Không đụng `frontend-website`
/ `backend-cms`.

**Nhánh:** `fix/auth-hardening` tách từ `fix-develop`.

## Hiện trạng (đã có, giữ nguyên)

- Hash mật khẩu bằng `argon2`.
- Refresh token: lưu hash, xoay vòng, revoke toàn bộ khi reset/đổi mật khẩu.
- Login lockout: 5 lần sai → khóa 15 phút (Redis, theo identifier).
- OTP: TTL 5 phút, tối đa 5 lần nhập sai thì huỷ mã, cooldown gửi lại 60s, namespace theo
  `purpose`.
- `forgot-password` & `resend-otp` trả response chung chung (không lộ email tồn tại).
- Đổi email/SĐT yêu cầu mật khẩu hiện tại + OTP.
- `helmet`, CORS whitelist, `ValidationPipe` whitelist + `forbidNonWhitelisted`.

## 12 mục cần làm

### 1. Rate limiting theo IP

- Thêm `@nestjs/throttler` + `@nest-lab/throttler-storage-redis`, dùng lại client
  `REDIS_CLIENT` (không tạo kết nối Redis mới).
- `src/common/throttler/throttler.module.ts`: `@Global`, `ThrottlerModule.forRootAsync`
  (inject `ConfigService` + `REDIS_CLIENT`), đăng ký `ThrottlerGuard` làm `APP_GUARD`.
- Giới hạn mặc định: `THROTTLE_LIMIT` (default 60) / `THROTTLE_TTL` (default 60s) mỗi IP.
- Override per-route bằng `@Throttle(...)`:
  | Route | Limit |
  |---|---|
  | `POST /auth/register` | 5 / 10 phút |
  | `POST /auth/login` | 10 / 5 phút |
  | `POST /auth/forgot-password` | 5 / 15 phút |
  | `POST /auth/reset-password` | 10 / 5 phút |
  | `POST /auth/verify-otp` | 10 / 5 phút |
  | `POST /auth/resend-otp` | 5 / 15 phút |
- `main.ts`: `app.set('trust proxy', 1)` khi `TRUST_PROXY=true` (UAT sau reverse proxy) để
  `req.ip` lấy đúng IP client.
- Custom guard override `throwThrottlingException()` → message tiếng Việt; `AllExceptionsFilter`
  hiện có tự format thành 429.
- Các route auth **không** áp throttler được gắn `@SkipThrottle()` nếu cần (vd `GET /auth/me`).

### 2. Register không lộ email đã đăng ký

- **Giữ nguyên** hành vi `409 ConflictException('Email đã được sử dụng')` — UX đăng ký rõ
  ràng, chuẩn thực tế cho e-commerce; không đổi API contract của FE.
- Chống dò email dựa vào throttler (5 req / 10 phút / IP ở mục 1).
- Không có thay đổi code ở mục này ngoài việc route đã được bọc throttler.

### 3. Login bắt buộc email đã xác thực

- `AuthService.login()`: **sau khi `argon2.verify` mật khẩu thành công** (không kiểm tra
  trước — tránh lộ trạng thái verify cho người không có mật khẩu), nếu `!user.emailVerifiedAt`:
  ```ts
  throw new ForbiddenException({
    statusCode: 403,
    error: 'EMAIL_NOT_VERIFIED',
    message: 'Tài khoản chưa xác thực email. Vui lòng kiểm tra hộp thư hoặc yêu cầu gửi lại mã.',
  });
  ```
  FE bắt `statusCode === 403 && error === 'EMAIL_NOT_VERIFIED'` để chuyển sang màn nhập OTP.
  Không cần sửa `AllExceptionsFilter` (đã forward field `error`).
- Đặt `clearLoginFailures()` **trước** check verify (mật khẩu đúng = đã xác thực danh tính,
  clear counter kể cả khi chưa cho vào vì chưa verify email).
- `prisma/seed.ts`: admin user set `emailVerifiedAt: new Date()`.
- `scripts/backfill-email-verified.ts`: script chạy tay 1 lần — set
  `emailVerifiedAt = createdAt` cho mọi user `status = ACTIVE` đang `emailVerifiedAt = null`,
  đồng thời `email = email.toLowerCase()` (phục vụ mục 8). Nêu trong mô tả PR.

### 4. Cooldown gửi lại mail ở forgot-password

- `AuthService.forgotPassword()`: key Redis `pwd-reset-cooldown:<email>` `EX 60`. Nếu key
  tồn tại → return im lặng (giữ nguyên tắc chống dò email — endpoint luôn trả message
  generic). Set key ngay trước khi gọi `mailService.sendPasswordResetEmail()`.
- Đặt hằng số `PASSWORD_RESET_COOLDOWN_SECONDS = 60` cạnh các hằng số hiện có trong
  `auth.service.ts`.

### 5. Token reset dùng-một-lần + chỉ link mới nhất còn hiệu lực

- `forgotPassword()`: sinh `jti = randomUUID()` (từ `node:crypto`). JWT payload
  `{ sub, purpose, jti }`. Ghi `pwd-reset-jti:<userId> = jti`, `EX 600` (10 phút) — ghi đè
  jti cũ nếu có → mọi link reset gửi trước đó thành vô hiệu.
- `resetPassword()`: sau khi verify JWT + check `purpose`, đọc `pwd-reset-jti:<userId>`;
  thiếu **hoặc** `!== payload.jti` → `BadRequestException('Token đặt lại mật khẩu không hợp
  lệ hoặc đã hết hạn.')`. Thành công → `redis.del('pwd-reset-jti:<userId>')` (single-use).
- Giữ nguyên bước revoke toàn bộ refresh token đang hoạt động.

### 6. Secret riêng cho token reset

- Thêm env `JWT_RESET_SECRET` (default dev `'change-me-reset-secret'`, khác access/refresh).
- `forgotPassword()` / `resetPassword()`: sign & verify token reset bằng
  `config.get('JWT_RESET_SECRET', 'change-me-reset-secret')` thay vì `JWT_SECRET`.
- Bỏ check `payload.purpose` dư thừa? → **giữ** (defense-in-depth, gần như miễn phí).

### 7. Chính sách mật khẩu

- Nâng độ dài tối thiểu lên **8** (theo NIST SP 800-63B; **không** ép ký tự đặc biệt):
  - `RegisterDto.password`: `@MinLength(8)`.
  - `ResetPasswordDto.newPassword`: `@MinLength(8)`.
  - `ChangePasswordDto.newPassword`: `@MinLength(8)`.
- Chặn đặt lại trùng mật khẩu hiện tại:
  - `UsersService.changePassword()`: `if (dto.newPassword === dto.currentPassword) throw new
    BadRequestException('Mật khẩu mới không được trùng mật khẩu hiện tại.')`.
  - `AuthService.resetPassword()`: load user theo `payload.sub`, nếu
    `await argon2.verify(user.password, newPassword)` → `BadRequestException('Mật khẩu mới
    không được trùng mật khẩu cũ.')`.
- `admin123` (seed) = 8 ký tự → vẫn hợp lệ, không cần đổi seed.

### 8. Chuẩn hóa email

- `src/common/utils/email.util.ts` (mới): `normalizeEmail(raw: string): string` →
  `raw.trim().toLowerCase()`. Lý do tách util: dùng ở ≥5 chỗ, không phụ thuộc model.
- Áp dụng ở `AuthService`: `register`, `login` (identifier — chỉ lowercase, `findByEmailOrPhone`
  vẫn thử cả phone), `forgotPassword`, `verifyOtp`, `resendOtp` — chuẩn hóa **trước khi**
  query/lưu.
- `RegisterDto` / `LoginDto` / các DTO email: thêm `@Transform(({ value }) =>
  typeof value === 'string' ? value.trim().toLowerCase() : value)` để chuẩn hóa ngay tại
  tầng validation (một nguồn sự thật). Service vẫn gọi `normalizeEmail()` cho chắc (đường
  vào từ chỗ khác).
- Data cũ: `scripts/backfill-email-verified.ts` (mục 3) lowercase luôn.

### 9. OTP sinh bằng CSPRNG

- `otp.service.ts` `generateOtpCode()`: `crypto.randomInt(0, 1_000_000).toString().padStart(6, '0')`
  (`import { randomInt } from 'node:crypto'`). Bỏ `Math.random()`.

### 10. Validate SĐT khi đăng ký

- `RegisterDto.phone`: thêm `@Matches(VN_PHONE_REGEX, { message: VN_PHONE_INVALID_MESSAGE })`
  (giữ `@IsOptional()`), import từ `common/utils/phone.util.ts` — nhất quán với
  `create-address.dto.ts`, `request-phone-change.dto.ts`.

### 11. Email cảnh báo sự kiện bảo mật

- `email.templates.ts`: template mới `passwordChangedEmailTemplate(context: 'reset' | 'change')`
  và `emailChangedNoticeTemplate(newEmailMasked)` , `phoneChangedNoticeTemplate()`.
- `MailService`: `sendPasswordChangedEmail(to)`, `sendEmailChangedNotice(oldEmail, newEmail)`,
  `sendPhoneChangedNotice(to)`. Tất cả best-effort — bọc trong try/catch, lỗi gửi chỉ log
  warn, **không** chặn/rollback nghiệp vụ (giống `sendConfirmationEmailBestEffort` ở orders).
- Gọi:
  - `AuthService.resetPassword()` thành công → `sendPasswordChangedEmail(user.email)`.
  - `UsersService.changePassword()` thành công → `sendPasswordChangedEmail(user.email)`.
  - `UsersService.confirmEmailChange()` thành công → `sendEmailChangedNotice(oldEmail, newEmail)`
    (gửi tới **email cũ** để cảnh báo nếu bị chiếm).
  - `UsersService.confirmPhoneChange()` thành công → `sendPhoneChangedNotice(user.email)`.
- Sửa luôn: `passwordResetEmailTemplate` ghi sai "Link có hiệu lực trong 15 phút" → "10 phút"
  (khớp `expiresIn: '10m'`).

### 12. Test cho module auth

CLAUDE.md yêu cầu auth có unit (service) + e2e (luồng chính).

- **Unit** `src/modules/auth/auth.service.spec.ts` — mock `PrismaService`, `UsersService`,
  `JwtService`, `ConfigService`, `MailService`, `OtpService`, Redis client:
  - `register`: mới OK / trùng email (409) / trùng phone (409) / gọi `otpService.send`.
  - `verifyOtp`: đúng mã / sai mã (400) / email lạ (400) / gọi `markEmailVerified` +
    `sendWelcomeEmail`.
  - `resendOtp`: email tồn tại → gửi / email lạ → im lặng, không gửi.
  - `login`: OK / sai mật khẩu (401) / bị lockout (401) / `status != ACTIVE` (401) /
    **`emailVerifiedAt = null` → 403 `EMAIL_NOT_VERIFIED`**.
  - `forgotPassword`: email lạ → không gửi / **cooldown còn hiệu lực → không gửi** / gửi
    thành công có set `pwd-reset-jti`.
  - `resetPassword`: OK / **jti sai (400)** / **jti đã bị xoá sau lần dùng trước (400)** /
    **newPassword trùng mật khẩu cũ (400)** / sai `purpose` (400) / token hết hạn (400) /
    revoke refresh token.
  - `refreshTokens`: OK + rotate / token đã revoke → 401.
  - `logout`.
- **Unit** `src/common/otp/otp.service.spec.ts`:
  - `send`: cooldown key tồn tại → `BadRequestException` / gửi OK set cả 2 key.
  - `consume`: đúng mã → true + xoá key / sai mã → false + tăng attempts / sai đủ
    `OTP_MAX_ATTEMPTS` → xoá key / key không tồn tại → false.
  - `generateOtpCode`: luôn 6 ký tự số, pad 0 khi cần.
- **e2e** `test/auth.e2e-spec.ts` (Redis + Postgres thật, giống các e2e orders):
  - Happy path: `register` → lấy OTP từ Redis → `verify-otp` → `login` OK, trả token.
  - `login` khi `emailVerifiedAt = null` → 403 `EMAIL_NOT_VERIFIED`.
  - `forgot-password` → lấy token từ mail log/Redis → `reset-password` OK → login bằng
    mật khẩu mới OK.
  - Gọi `reset-password` lần 2 với cùng token → 400.
  - Gọi `register` lần thứ 6 trong cửa sổ throttle → 429 (giảm limit qua env trong e2e).
  - Cleanup: xóa user + key Redis tạo trong test (afterAll, guard chống xóa unscoped như
    `orders.e2e-spec.ts`).
- e2e cần đặt `THROTTLE_LIMIT`/`THROTTLE_TTL` phù hợp qua env để test 429 mà không làm hỏng
  các test khác trong cùng file; hoặc dùng `@Throttle` limit thấp cố định cho route register
  và chấp nhận test tuần tự.

## Thay đổi cấu hình

`.env.example` thêm (không có giá trị thật):
```
# Rate limiting
THROTTLE_TTL=60
THROTTLE_LIMIT=60
TRUST_PROXY=false
# Secret riêng cho token đặt lại mật khẩu
JWT_RESET_SECRET=change-me-reset-secret
```

## Ngoài phạm vi (không làm đợt này — để đợt sau)

- Đổi UX register sang generic-response + mail "bạn đã có tài khoản" (mục 2 giữ 409).
- **Mục A** — Login constant-time chống enumeration qua timing (verify hash giả khi user
  không tồn tại).
- **Mục B** — Refresh token reuse detection (token đã revoke bị dùng lại → revoke all).
- **Mục C** — Cap độ dài mật khẩu `@MaxLength(128)` chống DoS argon2.
- **Mục D** — Check mật khẩu trong danh sách lộ (HaveIBeenPwned k-anonymity).
- MFA/2FA, quản lý phiên đăng nhập (list/revoke thiết bị), CAPTCHA, audit log có cấu trúc.
- Template engine (Handlebars/MJML), gửi OTP/SMS thật.
