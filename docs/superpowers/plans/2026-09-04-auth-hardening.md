# Auth Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Đưa 4 luồng auth của `backend-user` (đăng ký, xác thực OTP, quên mật khẩu, đổi mật khẩu) lên mức bảo mật baseline theo spec `docs/superpowers/specs/2026-09-04-auth-hardening-design.md` (12 mục).

**Architecture:** NestJS 11 + Prisma + Redis (ioredis, `REDIS_CLIENT` token) + argon2 + `@nestjs/jwt`. Không đổi schema Prisma. Mọi state phụ trợ (cooldown, jti reset, đếm request) nằm ở Redis. Rate limit bằng `@nestjs/throttler` với storage Redis.

**Tech Stack:** TypeScript, NestJS, class-validator/class-transformer, Jest + ts-jest (unit `src/**/*.spec.ts`, e2e `test/**/*.e2e-spec.ts` qua `test/jest-e2e.json`), supertest.

## Global Constraints

- Không sửa `vendor/backend-cms/prisma/schema.prisma` hay tạo migration; không bump submodule `vendor/backend-cms`.
- Không `git add vendor/backend-cms` trong bất kỳ commit nào (working tree đang có thay đổi submodule chưa commit — bỏ qua nó).
- Mọi input client phải qua DTO trong `dto/` với `class-validator` + `@ApiProperty()`.
- Ném `HttpException` con của Nest, không tự format lỗi. `AllExceptionsFilter` (global) đã format `{ statusCode, message, error, timestamp, path }` và forward field `error`.
- Không log/echo mật khẩu hay OTP ở bất kỳ đâu (kể cả tạm).
- Mật khẩu hash bằng `argon2.hash` / so khớp bằng `argon2.verify`.
- Secret/URL luôn qua `ConfigService.get(key, default)` với default hợp lý cho dev.
- Thêm env mới → thêm vào `.env.example` (không giá trị thật).
- Lint sạch: `pnpm --filter @clothing-shop/be lint`. Build: `pnpm --filter @clothing-shop/be build`.
- Chạy test: `pnpm --filter @clothing-shop/be test` (unit) và `pnpm --filter @clothing-shop/be test:e2e` (e2e). Trong thư mục `backend-user` có thể chạy trực tiếp `pnpm test` / `pnpm test:e2e`.
- Commit nhỏ theo từng bước. Cuối message commit:
  ```
  Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
  ```
- Không push, không mở PR khi chưa được yêu cầu.

## File Structure

**Tạo mới:**
- `src/common/utils/email.util.ts` — `normalizeEmail()`, `maskEmail()`.
- `src/common/utils/email.util.spec.ts` — unit test util trên.
- `src/common/throttler/throttler.module.ts` — `AppThrottlerModule` (global), cấu hình `ThrottlerModule` + storage Redis + đăng ký guard.
- `src/common/throttler/vi-throttler.guard.ts` — `ViThrottlerGuard` extends `ThrottlerGuard`, message 429 tiếng Việt.
- `src/common/throttler/redis-throttler.storage.ts` — `RedisThrottlerStorage` (chỉ dùng nếu không cài được package storage; xem Task 10 Step 1).
- `src/common/throttler/vi-throttler.guard.spec.ts` — unit test message.
- `src/modules/auth/auth.service.spec.ts` — unit test `AuthService`.
- `src/common/otp/otp.service.spec.ts` — unit test `OtpService`.
- `src/modules/users/users.service.spec.ts` — unit test phần password/notify của `UsersService`.
- `scripts/backfill-email-verified.ts` — script chạy tay 1 lần cho data cũ.
- `test/auth.e2e-spec.ts` — e2e luồng auth.
- `test/auth-throttle.e2e-spec.ts` — e2e riêng cho rate limit (throttler bật thật).

**Sửa:**
- `src/modules/auth/auth.service.ts` — normalize email; reset secret riêng; jti single-use; forgot cooldown; login bắt buộc verify email; gửi mail cảnh báo sau reset.
- `src/modules/auth/auth.controller.ts` — `@Throttle(...)` per-route.
- `src/modules/auth/dto/register.dto.ts` — `@MinLength(8)` password; `@Matches(VN_PHONE_REGEX)` phone; `@Transform` lowercase email.
- `src/modules/auth/dto/login.dto.ts` — `@Transform` trim+lowercase identifier.
- `src/modules/auth/dto/forgot-password.dto.ts`, `verify-otp.dto.ts`, `resend-otp.dto.ts` — `@Transform` lowercase email.
- `src/modules/auth/dto/reset-password.dto.ts` — `@MinLength(8)` newPassword.
- `src/modules/users/dto/change-password.dto.ts` — `@MinLength(8)` newPassword.
- `src/modules/users/users.service.ts` — chặn newPassword trùng currentPassword; gửi mail cảnh báo sau change-password / đổi email / đổi SĐT.
- `src/modules/users/users.module.ts` — `imports: [OtpModule, MailModule]`.
- `src/common/otp/otp.service.ts` — `generateOtpCode()` dùng `crypto.randomInt`.
- `src/modules/mail/mail.service.ts` — thêm `sendPasswordChangedEmail`, `sendEmailChangedNotice`, `sendPhoneChangedNotice` (best-effort).
- `src/modules/mail/templates/email.templates.ts` — thêm 3 template cảnh báo; sửa "15 phút" → "10 phút".
- `src/modules/mail/templates/email.templates.spec.ts` — thêm assertion cho template mới.
- `src/app.module.ts` — import `AppThrottlerModule`.
- `src/main.ts` — `trust proxy` khi `TRUST_PROXY=true`.
- `prisma/seed.ts` — admin `emailVerifiedAt`.
- `package.json` — deps throttler; script `backfill:email-verified`.
- `.env.example` — `JWT_RESET_SECRET`, `THROTTLE_TTL`, `THROTTLE_LIMIT`, `TRUST_PROXY`.

---

## Task 1: Email normalization util

**Files:**
- Create: `src/common/utils/email.util.ts`
- Create: `src/common/utils/email.util.spec.ts`

**Interfaces:**
- Produces:
  - `normalizeEmail(raw: string): string` — `raw.trim().toLowerCase()`.
  - `maskEmail(email: string): string` — che phần local, giữ ký tự đầu + cuối local part và nguyên domain: `"john.doe@example.com"` → `"j******e@example.com"`; local ≤ 2 ký tự → che hết local (`"ab@x.com"` → `"**@x.com"`); chuỗi không có `@` → trả nguyên.

- [ ] **Step 1: Write the failing test**

`src/common/utils/email.util.spec.ts`:
```ts
import { normalizeEmail, maskEmail } from './email.util';

describe('normalizeEmail', () => {
  it('trims and lowercases', () => {
    expect(normalizeEmail('  John.Doe@Example.COM ')).toBe('john.doe@example.com');
  });
});

describe('maskEmail', () => {
  it('keeps first and last char of local part', () => {
    expect(maskEmail('john.doe@example.com')).toBe('j******e@example.com');
  });

  it('masks the whole local part when it is 2 chars or fewer', () => {
    expect(maskEmail('ab@x.com')).toBe('**@x.com');
  });

  it('returns the input unchanged when there is no @', () => {
    expect(maskEmail('not-an-email')).toBe('not-an-email');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- email.util`
Expected: FAIL — `Cannot find module './email.util'`.

- [ ] **Step 3: Implement**

`src/common/utils/email.util.ts`:
```ts
// Chuẩn hóa email trước khi query/lưu — email phân biệt hoa thường ở cột unique của Postgres,
// không chuẩn hóa sẽ tạo được 2 tài khoản "trùng" (Test@x.com vs test@x.com).
export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

// Che bớt email khi hiển thị trong mail cảnh báo bảo mật (không lộ đầy đủ địa chỉ mới cho
// người đọc mail ở địa chỉ cũ).
export function maskEmail(email: string): string {
  const atIndex = email.indexOf('@');
  if (atIndex === -1) return email;

  const local = email.slice(0, atIndex);
  const domain = email.slice(atIndex);

  if (local.length <= 2) {
    return `${'*'.repeat(local.length)}${domain}`;
  }
  return `${local[0]}${'*'.repeat(local.length - 2)}${local[local.length - 1]}${domain}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- email.util`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/common/utils/email.util.ts src/common/utils/email.util.spec.ts
git commit -m "feat(auth): add email normalize/mask util"
```

---

## Task 2: Apply email normalization across auth flows (#8)

**Files:**
- Modify: `src/modules/auth/auth.service.ts`
- Modify: `src/modules/auth/dto/register.dto.ts`
- Modify: `src/modules/auth/dto/login.dto.ts`
- Modify: `src/modules/auth/dto/forgot-password.dto.ts`
- Modify: `src/modules/auth/dto/verify-otp.dto.ts`
- Modify: `src/modules/auth/dto/resend-otp.dto.ts`
- Test: `src/modules/auth/auth.service.spec.ts` (create; grows in later tasks)

**Interfaces:**
- Consumes: `normalizeEmail` from `src/common/utils/email.util.ts`.
- Produces: after this task `AuthService.register/login/forgotPassword/verifyOtp/resendOtp` all operate on normalized email. `login` passes the normalized identifier to `usersService.findByEmailOrPhone`.

- [ ] **Step 1: Write the failing test**

`src/modules/auth/auth.service.spec.ts` (new file — minimal harness now, extended later):
```ts
import { AuthService } from './auth.service';
import { UsersService } from '../users/users.service';
import { PrismaService } from '../../config/prisma.service';
import { MailService } from '../mail/mail.service';
import { OtpService } from '../../common/otp/otp.service';

function createHarness() {
  const usersService = {
    findByEmail: jest.fn(),
    findByPhone: jest.fn(),
    findByEmailOrPhone: jest.fn(),
    findById: jest.fn(),
    create: jest.fn(),
    markEmailVerified: jest.fn(),
    updatePassword: jest.fn(),
  } as unknown as jest.Mocked<UsersService>;

  const prisma = {
    refreshToken: {
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
  } as unknown as PrismaService;

  const jwtService = {
    signAsync: jest.fn().mockResolvedValue('signed.jwt.token'),
    verifyAsync: jest.fn(),
  } as unknown as import('@nestjs/jwt').JwtService;

  const values: Record<string, string> = {};
  const config = {
    get: jest.fn((k: string, d?: string) => values[k] ?? d),
  } as unknown as import('@nestjs/config').ConfigService;

  const mailService = {
    sendWelcomeEmail: jest.fn(),
    sendPasswordResetEmail: jest.fn(),
    sendPasswordChangedEmail: jest.fn(),
  } as unknown as MailService;

  const otpService = {
    send: jest.fn(),
    consume: jest.fn(),
  } as unknown as OtpService;

  const redis = {
    get: jest.fn(),
    set: jest.fn(),
    del: jest.fn(),
    incr: jest.fn(),
    expire: jest.fn(),
    exists: jest.fn().mockResolvedValue(0),
  } as unknown as import('ioredis').default;

  const service = new AuthService(
    usersService,
    prisma,
    jwtService,
    config,
    mailService,
    otpService,
    redis,
  );

  return { service, usersService, prisma, jwtService, config, mailService, otpService, redis };
}

export { createHarness };

describe('AuthService email normalization', () => {
  it('register looks up and creates with a normalized email', async () => {
    const h = createHarness();
    (h.usersService.findByEmail as jest.Mock).mockResolvedValue(null);
    (h.usersService.create as jest.Mock).mockResolvedValue({
      id: 'u1',
      email: 'user@example.com',
      password: 'hash',
      fullName: 'U',
    });

    await h.service.register({
      email: '  User@Example.COM ',
      password: 'password1',
      fullName: 'U',
    } as any);

    expect(h.usersService.findByEmail).toHaveBeenCalledWith('user@example.com');
    expect((h.usersService.create as jest.Mock).mock.calls[0][0].email).toBe('user@example.com');
    expect(h.otpService.send).toHaveBeenCalledWith('register', 'user@example.com');
  });

  it('login queries with the normalized identifier', async () => {
    const h = createHarness();
    (h.usersService.findByEmailOrPhone as jest.Mock).mockResolvedValue(null);

    await expect(
      h.service.login({ identifier: '  User@Example.COM ', password: 'password1' } as any),
    ).rejects.toThrow();

    expect(h.usersService.findByEmailOrPhone).toHaveBeenCalledWith('user@example.com');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- auth.service`
Expected: FAIL — `register` calls `findByEmail` with the raw string; `login` calls `findByEmailOrPhone` with raw `dto.identifier`.

- [ ] **Step 3: Implement**

In `src/modules/auth/auth.service.ts`:
1. Add import: `import { normalizeEmail } from '../../common/utils/email.util';`
2. `register()`: first line — `const email = normalizeEmail(dto.email);` then use `email` for `findByEmail`, `usersService.create({ email, ... })`, and `otpService.send(REGISTER_OTP_PURPOSE, email)`. Return value unchanged.
3. `login()`: change line `const identifier = dto.identifier.trim().toLowerCase();` stays; change `const user = await this.usersService.findByEmailOrPhone(dto.identifier);` → `findByEmailOrPhone(identifier)`.
4. `verifyOtp(email, code)`: first line — `email = normalizeEmail(email);` (reassign param or use local `const normalized`). Use normalized for `findByEmail` and `otpService.consume`.
5. `resendOtp(email)`: `const normalized = normalizeEmail(email);` use for `findByEmail` + `otpService.send`; keep return message.
6. `forgotPassword(email)`: `const normalized = normalizeEmail(email);` use everywhere `email` currently used (lookup, `sendPasswordResetEmail`, and later the cooldown/jti keys in Tasks 6–7).

In DTOs add a transform so the normalized value is also what validation/Swagger sees. Example for `register.dto.ts`:
```ts
import { Transform } from 'class-transformer';

  @ApiProperty()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsEmail()
  email: string;
```
Apply the same `@Transform` line to: `forgot-password.dto.ts` (`email`), `verify-otp.dto.ts` (`email`), `resend-otp.dto.ts` (`email`), and `login.dto.ts` (`identifier`).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- auth.service`
Expected: PASS.

- [ ] **Step 5: Lint + commit**

```bash
pnpm lint
git add src/modules/auth/auth.service.ts src/modules/auth/auth.service.spec.ts src/modules/auth/dto/
git commit -m "feat(auth): normalize email across register/login/forgot/otp flows"
```

---

## Task 3: OTP code via CSPRNG (#9)

**Files:**
- Modify: `src/common/otp/otp.service.ts`
- Create: `src/common/otp/otp.service.spec.ts`

**Interfaces:**
- Produces: `OtpService` unchanged public API; `generateOtpCode()` now uses `crypto.randomInt`.

- [ ] **Step 1: Write the failing test**

`src/common/otp/otp.service.spec.ts`:
```ts
import { BadRequestException } from '@nestjs/common';
import { OtpService } from './otp.service';
import { MailService } from '../../modules/mail/mail.service';

function createHarness() {
  const store = new Map<string, string>();
  const redis = {
    exists: jest.fn(async (k: string) => (store.has(k) ? 1 : 0)),
    set: jest.fn(async (k: string, v: string) => {
      store.set(k, v);
      return 'OK';
    }),
    get: jest.fn(async (k: string) => store.get(k) ?? null),
    del: jest.fn(async (k: string) => {
      store.delete(k);
      return 1;
    }),
  } as unknown as import('ioredis').default;

  const mailService = { sendOtpEmail: jest.fn() } as unknown as MailService;
  const service = new OtpService(redis, mailService);
  return { service, redis, mailService, store };
}

describe('OtpService.send', () => {
  it('emails a 6-digit numeric code', async () => {
    const h = createHarness();
    await h.service.send('register', 'a@b.com');
    const code = (h.mailService.sendOtpEmail as jest.Mock).mock.calls[0][1];
    expect(code).toMatch(/^\d{6}$/);
  });

  it('generates a zero-padded 6-digit code across many runs', async () => {
    const h = createHarness();
    for (let i = 0; i < 200; i++) {
      h.store.clear();
      await h.service.send('register', `u${i}@b.com`);
      const code = (h.mailService.sendOtpEmail as jest.Mock).mock.calls[i][1];
      expect(code).toMatch(/^\d{6}$/);
    }
  });

  it('rejects when the resend cooldown key exists', async () => {
    const h = createHarness();
    await h.service.send('register', 'a@b.com');
    await expect(h.service.send('register', 'a@b.com')).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('OtpService.consume', () => {
  it('accepts the right code once and deletes it', async () => {
    const h = createHarness();
    await h.service.send('register', 'a@b.com');
    const code = (h.mailService.sendOtpEmail as jest.Mock).mock.calls[0][1];
    expect(await h.service.consume('register', 'a@b.com', code)).toBe(true);
    expect(await h.service.consume('register', 'a@b.com', code)).toBe(false);
  });

  it('drops the code after 5 wrong attempts', async () => {
    const h = createHarness();
    await h.service.send('register', 'a@b.com');
    const code = (h.mailService.sendOtpEmail as jest.Mock).mock.calls[0][1];
    for (let i = 0; i < 5; i++) {
      expect(await h.service.consume('register', 'a@b.com', '000000')).toBe(false);
    }
    expect(await h.service.consume('register', 'a@b.com', code)).toBe(false);
  });

  it('returns false when there is no stored code', async () => {
    const h = createHarness();
    expect(await h.service.consume('register', 'nobody@b.com', '123456')).toBe(false);
  });
});
```
Note: the `set` mock ignores the `'KEEPTTL'` / `'EX'` variadic args — acceptable for these tests. If `consume`'s wrong-attempt path calls `redis.set(key, json, 'KEEPTTL')`, the mock still stores the value.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- otp.service`
Expected: the "zero-padded across many runs" test is the guard — currently `Math.floor(100000 + Math.random() * 900000)` never produces a value needing padding, but also never fails `/^\d{6}$/`, so this test PASSES already. The real failing signal: add this assertion to Step 1 instead — spy that `Math.random` is NOT used. Replace the "many runs" test body with:
```ts
  it('does not use Math.random for code generation', async () => {
    const spy = jest.spyOn(Math, 'random');
    const h = createHarness();
    await h.service.send('register', 'a@b.com');
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
```
Run again: FAIL — `Math.random` was called.

- [ ] **Step 3: Implement**

In `src/common/otp/otp.service.ts`:
1. Add import at top: `import { randomInt } from 'node:crypto';`
2. Replace `generateOtpCode`:
```ts
function generateOtpCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, '0');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- otp.service`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/common/otp/otp.service.ts src/common/otp/otp.service.spec.ts
git commit -m "feat(auth): generate OTP with crypto.randomInt instead of Math.random"
```

---

## Task 4: DTO hardening — password length + register phone (#7 length, #10)

**Files:**
- Modify: `src/modules/auth/dto/register.dto.ts`
- Modify: `src/modules/auth/dto/reset-password.dto.ts`
- Modify: `src/modules/users/dto/change-password.dto.ts`
- Create: `src/modules/auth/dto/auth-dto.spec.ts`

**Interfaces:**
- Produces: `RegisterDto.password` / `ResetPasswordDto.newPassword` / `ChangePasswordDto.newPassword` require min length 8. `RegisterDto.phone` (when present) must match `VN_PHONE_REGEX` (`/^0\d{9}$/`).

- [ ] **Step 1: Write the failing test**

`src/modules/auth/dto/auth-dto.spec.ts`:
```ts
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { RegisterDto } from './register.dto';
import { ResetPasswordDto } from './reset-password.dto';

function errorsFor<T extends object>(cls: new () => T, payload: Record<string, unknown>) {
  const dto = plainToInstance(cls, payload);
  return validateSync(dto as object).flatMap((e) => Object.keys(e.constraints ?? {}));
}

describe('RegisterDto', () => {
  const base = { email: 'a@b.com', password: 'password1', fullName: 'Nguyen Van A' };

  it('rejects a password shorter than 8', () => {
    expect(errorsFor(RegisterDto, { ...base, password: 'short7!' })).toContain('minLength');
  });

  it('accepts an 8-char password', () => {
    expect(errorsFor(RegisterDto, base)).toHaveLength(0);
  });

  it('rejects a malformed phone', () => {
    expect(errorsFor(RegisterDto, { ...base, phone: '12345' })).toContain('matches');
  });

  it('accepts a valid VN phone', () => {
    expect(errorsFor(RegisterDto, { ...base, phone: '0901234567' })).toHaveLength(0);
  });

  it('still allows an omitted phone', () => {
    expect(errorsFor(RegisterDto, base)).toHaveLength(0);
  });
});

describe('ResetPasswordDto', () => {
  it('rejects a newPassword shorter than 8', () => {
    expect(errorsFor(ResetPasswordDto, { token: 't', newPassword: 'short7!' })).toContain('minLength');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- auth-dto`
Expected: FAIL — `password: 'short7!'` (7 chars) currently passes `@MinLength(6)`; phone `'12345'` currently passes `@IsString()`.

- [ ] **Step 3: Implement**

`register.dto.ts`:
```ts
import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsOptional, IsString, Matches, MinLength } from 'class-validator';
import { VN_PHONE_REGEX, VN_PHONE_INVALID_MESSAGE } from '../../../common/utils/phone.util';

export class RegisterDto {
  @ApiProperty()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsEmail()
  email: string;

  @ApiProperty({ minLength: 8 })
  @IsString()
  @MinLength(8)
  password: string;

  @ApiProperty()
  @IsString()
  @MinLength(2)
  fullName: string;

  @ApiProperty({ required: false, example: '0901234567' })
  @IsOptional()
  @IsString()
  @Matches(VN_PHONE_REGEX, { message: VN_PHONE_INVALID_MESSAGE })
  phone?: string;
}
```
(If Task 2 already added the `@Transform` import/line, keep it — do not duplicate.)

`reset-password.dto.ts`: change `@MinLength(6)` → `@MinLength(8)` on `newPassword`, and `@ApiProperty({ minLength: 6 })` → `{ minLength: 8 }`.

`change-password.dto.ts`: change `@MinLength(6)` → `@MinLength(8)` on `newPassword`, and `@ApiProperty({ minLength: 6 })` → `{ minLength: 8 }`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- auth-dto`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/auth/dto/ src/modules/users/dto/change-password.dto.ts
git commit -m "feat(auth): enforce 8-char password minimum and validate register phone"
```

---

## Task 5: Block reusing the current/old password (#7 reuse)

**Files:**
- Modify: `src/modules/users/users.service.ts`
- Modify: `src/modules/auth/auth.service.ts`
- Create: `src/modules/users/users.service.spec.ts`
- Modify: `src/modules/auth/auth.service.spec.ts`

**Interfaces:**
- Consumes: `argon2.verify`, `usersService.findById`.
- Produces:
  - `UsersService.changePassword` throws `BadRequestException('Mật khẩu mới không được trùng mật khẩu hiện tại.')` when `dto.newPassword === dto.currentPassword`.
  - `AuthService.resetPassword` loads the user by `payload.sub` and throws `BadRequestException('Mật khẩu mới không được trùng mật khẩu cũ.')` when `argon2.verify(user.password, newPassword)` is true. Also throws `BadRequestException('Token đặt lại mật khẩu không hợp lệ hoặc đã hết hạn')` when the user no longer exists.

- [ ] **Step 1: Write the failing tests**

`src/modules/users/users.service.spec.ts`:
```ts
import { BadRequestException } from '@nestjs/common';
import * as argon2 from 'argon2';
import { UsersService } from './users.service';
import { PrismaService } from '../../config/prisma.service';
import { OtpService } from '../../common/otp/otp.service';
import { MailService } from '../mail/mail.service';

function createHarness() {
  const prisma = {
    user: { findUnique: jest.fn(), update: jest.fn() },
    refreshToken: { updateMany: jest.fn() },
  } as unknown as PrismaService;
  const otpService = { send: jest.fn(), consume: jest.fn() } as unknown as OtpService;
  const mailService = {
    sendPasswordChangedEmail: jest.fn(),
    sendEmailChangedNotice: jest.fn(),
    sendPhoneChangedNotice: jest.fn(),
  } as unknown as MailService;
  const service = new UsersService(prisma, otpService, mailService);
  return { service, prisma, otpService, mailService };
}

describe('UsersService.changePassword', () => {
  it('rejects when the new password equals the current one', async () => {
    const h = createHarness();
    const hash = await argon2.hash('password1');
    (h.prisma.user.findUnique as jest.Mock).mockResolvedValue({ id: 'u1', password: hash, email: 'u@b.com' });

    await expect(
      h.service.changePassword('u1', { currentPassword: 'password1', newPassword: 'password1' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
```

Append to `src/modules/auth/auth.service.spec.ts`:
```ts
import * as argon2 from 'argon2';

describe('AuthService.resetPassword password reuse', () => {
  it('rejects a new password identical to the stored one', async () => {
    const h = createHarness();
    const hash = await argon2.hash('oldpassword');
    (h.jwtService.verifyAsync as jest.Mock).mockResolvedValue({ sub: 'u1', purpose: 'reset-password', jti: 'j1' });
    (h.usersService.findById as jest.Mock).mockResolvedValue({ id: 'u1', password: hash, email: 'u@b.com' });
    (h.redis.get as jest.Mock).mockResolvedValue('j1'); // jti check added in Task 7; harmless here

    await expect(h.service.resetPassword('token', 'oldpassword')).rejects.toThrow(
      'Mật khẩu mới không được trùng mật khẩu cũ.',
    );
  });
});
```
(If Task 7 is not yet done, the `redis.get` line is ignored by current code — safe.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- users.service auth.service`
Expected: FAIL — `changePassword` has no equality check; `resetPassword` does not load the user.

- [ ] **Step 3: Implement**

`users.service.ts`:
1. Constructor: add `private readonly mailService: MailService,` param and `import { MailService } from '../mail/mail.service';`. (Used fully in Task 9; wired now so the spec harness matches.)
2. In `changePassword`, right after `await this.verifyCurrentPassword(user, dto.currentPassword);`:
```ts
    if (dto.newPassword === dto.currentPassword) {
      throw new BadRequestException('Mật khẩu mới không được trùng mật khẩu hiện tại.');
    }
```

`users.module.ts`: `imports: [OtpModule, MailModule]` + `import { MailModule } from '../mail/mail.module';`.

`auth.service.ts` `resetPassword`, after the `payload.purpose !== RESET_TOKEN_PURPOSE` check and before hashing:
```ts
    const user = await this.usersService.findById(payload.sub);
    if (!user) {
      throw new BadRequestException(
        'Token đặt lại mật khẩu không hợp lệ hoặc đã hết hạn',
      );
    }
    if (await argon2.verify(user.password, newPassword)) {
      throw new BadRequestException('Mật khẩu mới không được trùng mật khẩu cũ.');
    }
```
Then keep the existing `const passwordHash = await argon2.hash(newPassword);` etc. Change `updatePassword(payload.sub, ...)` to `updatePassword(user.id, ...)` and `refreshToken.updateMany({ where: { userId: user.id ... } })` for consistency.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test -- users.service auth.service`
Expected: PASS.

- [ ] **Step 5: Lint + commit**

```bash
pnpm lint
git add src/modules/users/users.service.ts src/modules/users/users.service.spec.ts src/modules/users/users.module.ts src/modules/auth/auth.service.ts src/modules/auth/auth.service.spec.ts
git commit -m "feat(auth): reject reusing the current password on reset and change"
```

---

## Task 6: Dedicated secret for the reset token (#6)

**Files:**
- Modify: `src/modules/auth/auth.service.ts`
- Modify: `.env.example`
- Modify: `src/modules/auth/auth.service.spec.ts`

**Interfaces:**
- Produces: `forgotPassword` signs the reset JWT with `config.get('JWT_RESET_SECRET', 'change-me-reset-secret')`; `resetPassword` verifies with the same. A token signed with `JWT_SECRET` no longer validates in `resetPassword`.

- [ ] **Step 1: Write the failing test**

Append to `auth.service.spec.ts`:
```ts
describe('AuthService reset token secret', () => {
  it('signs forgot-password token with JWT_RESET_SECRET', async () => {
    const h = createHarness();
    (h.usersService.findByEmail as jest.Mock).mockResolvedValue({ id: 'u1', email: 'u@b.com' });

    await h.service.forgotPassword('u@b.com');

    const signCall = (h.jwtService.signAsync as jest.Mock).mock.calls.find(
      ([payload]) => payload?.purpose === 'reset-password',
    );
    expect(signCall).toBeDefined();
    expect(signCall[1].secret).toBe('change-me-reset-secret');
  });

  it('verifies reset token with JWT_RESET_SECRET', async () => {
    const h = createHarness();
    (h.jwtService.verifyAsync as jest.Mock).mockRejectedValue(new Error('bad sig'));

    await expect(h.service.resetPassword('token', 'newpassword1')).rejects.toThrow();
    expect((h.jwtService.verifyAsync as jest.Mock).mock.calls[0][1].secret).toBe('change-me-reset-secret');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- auth.service`
Expected: FAIL — current code uses `JWT_SECRET` default `'change-me-access-secret'`.

- [ ] **Step 3: Implement**

`auth.service.ts`:
1. Add constant near the top: `const RESET_TOKEN_SECRET_KEY = 'JWT_RESET_SECRET';` and `const RESET_TOKEN_SECRET_DEFAULT = 'change-me-reset-secret';`
2. In `forgotPassword`, the `signAsync` `secret:` → `this.config.get<string>(RESET_TOKEN_SECRET_KEY, RESET_TOKEN_SECRET_DEFAULT)`.
3. In `resetPassword`, the `verifyAsync` `secret:` → same.

`.env.example` — add after the `JWT_REFRESH_EXPIRES_IN` line:
```
# Secret riêng cho token đặt lại mật khẩu (tách khỏi JWT_SECRET để lộ 1 cái không kéo theo cái kia)
JWT_RESET_SECRET="change-me-user-reset-secret"
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- auth.service`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/auth/auth.service.ts src/modules/auth/auth.service.spec.ts .env.example
git commit -m "feat(auth): sign password-reset token with a dedicated secret"
```

---

## Task 7: Single-use, single-outstanding reset token via Redis jti (#5)

**Files:**
- Modify: `src/modules/auth/auth.service.ts`
- Modify: `src/modules/auth/auth.service.spec.ts`

**Interfaces:**
- Consumes: `randomUUID` from `node:crypto`; `redis.set/get/del`.
- Produces:
  - `forgotPassword` puts `jti` in the JWT payload and writes `pwd-reset-jti:<userId> = jti` with `EX 600` (overwrites any prior).
  - `resetPassword` requires `redis.get('pwd-reset-jti:<sub>') === payload.jti`, else `BadRequestException('Token đặt lại mật khẩu không hợp lệ hoặc đã hết hạn.')`. On success it `del`s the key (so the token cannot be reused).

- [ ] **Step 1: Write the failing tests**

Append to `auth.service.spec.ts`:
```ts
describe('AuthService reset token jti', () => {
  const validPayload = { sub: 'u1', purpose: 'reset-password', jti: 'jti-123' };

  function primeResetOk(h: ReturnType<typeof createHarness>) {
    (h.jwtService.verifyAsync as jest.Mock).mockResolvedValue(validPayload);
    (h.usersService.findById as jest.Mock).mockResolvedValue({ id: 'u1', password: 'hash-of-something-else', email: 'u@b.com' });
    // argon2.verify against a bogus hash throws -> treat as "not the same password"
    jest.spyOn(argon2, 'verify').mockResolvedValue(false);
  }

  it('stores a jti when issuing the reset link', async () => {
    const h = createHarness();
    (h.usersService.findByEmail as jest.Mock).mockResolvedValue({ id: 'u1', email: 'u@b.com' });

    await h.service.forgotPassword('u@b.com');

    const setCall = (h.redis.set as jest.Mock).mock.calls.find(([k]) => String(k).startsWith('pwd-reset-jti:u1'));
    expect(setCall).toBeDefined();
    const signedJti = (h.jwtService.signAsync as jest.Mock).mock.calls.find(
      ([p]) => p?.purpose === 'reset-password',
    )[0].jti;
    expect(setCall[1]).toBe(signedJti);
  });

  it('rejects when the stored jti does not match', async () => {
    const h = createHarness();
    primeResetOk(h);
    (h.redis.get as jest.Mock).mockResolvedValue('a-different-jti');

    await expect(h.service.resetPassword('token', 'newpassword1')).rejects.toThrow(
      'Token đặt lại mật khẩu không hợp lệ hoặc đã hết hạn.',
    );
  });

  it('rejects when there is no stored jti (already used / expired)', async () => {
    const h = createHarness();
    primeResetOk(h);
    (h.redis.get as jest.Mock).mockResolvedValue(null);

    await expect(h.service.resetPassword('token', 'newpassword1')).rejects.toThrow();
  });

  it('deletes the jti after a successful reset', async () => {
    const h = createHarness();
    primeResetOk(h);
    (h.redis.get as jest.Mock).mockResolvedValue('jti-123');
    (h.usersService.updatePassword as jest.Mock).mockResolvedValue({});

    await h.service.resetPassword('token', 'newpassword1');

    expect(h.redis.del).toHaveBeenCalledWith('pwd-reset-jti:u1');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- auth.service`
Expected: FAIL — no jti in payload, no Redis interaction in reset flow.

- [ ] **Step 3: Implement**

`auth.service.ts`:
1. Import: `import { randomUUID } from 'node:crypto';`
2. Constants near the top:
```ts
const RESET_JTI_PREFIX = 'pwd-reset-jti:';
const RESET_TOKEN_TTL_SECONDS = 10 * 60;
```
3. `forgotPassword` — where the token is signed:
```ts
    const jti = randomUUID();
    const resetToken = await this.jwtService.signAsync(
      { sub: user.id, purpose: RESET_TOKEN_PURPOSE, jti },
      {
        secret: this.config.get<string>(RESET_TOKEN_SECRET_KEY, RESET_TOKEN_SECRET_DEFAULT),
        expiresIn: '10m',
      },
    );
    await this.redis.set(
      `${RESET_JTI_PREFIX}${user.id}`,
      jti,
      'EX',
      RESET_TOKEN_TTL_SECONDS,
    );
```
4. `resetPassword` — payload type becomes `{ sub: string; purpose: string; jti: string }`. After the `purpose` check and after loading `user` (Task 5), add:
```ts
    const storedJti = await this.redis.get(`${RESET_JTI_PREFIX}${payload.sub}`);
    if (!storedJti || storedJti !== payload.jti) {
      throw new BadRequestException(
        'Token đặt lại mật khẩu không hợp lệ hoặc đã hết hạn.',
      );
    }
```
5. At the end of `resetPassword`, after the `refreshToken.updateMany` revoke:
```ts
    await this.redis.del(`${RESET_JTI_PREFIX}${payload.sub}`);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test -- auth.service`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/auth/auth.service.ts src/modules/auth/auth.service.spec.ts
git commit -m "feat(auth): make password-reset tokens single-use via Redis jti"
```

---

## Task 8: forgot-password send cooldown (#4)

**Files:**
- Modify: `src/modules/auth/auth.service.ts`
- Modify: `src/modules/auth/auth.service.spec.ts`

**Interfaces:**
- Produces: `forgotPassword` checks `redis.exists('pwd-reset-cooldown:<email>')`; if set, returns without sending. On send it writes that key with `EX 60`.

- [ ] **Step 1: Write the failing tests**

Append to `auth.service.spec.ts`:
```ts
describe('AuthService.forgotPassword cooldown', () => {
  it('does not send a second email while the cooldown is active', async () => {
    const h = createHarness();
    (h.usersService.findByEmail as jest.Mock).mockResolvedValue({ id: 'u1', email: 'u@b.com' });
    (h.redis.exists as jest.Mock).mockResolvedValue(1);

    await h.service.forgotPassword('u@b.com');

    expect(h.mailService.sendPasswordResetEmail).not.toHaveBeenCalled();
  });

  it('sends and sets the cooldown key when not on cooldown', async () => {
    const h = createHarness();
    (h.usersService.findByEmail as jest.Mock).mockResolvedValue({ id: 'u1', email: 'u@b.com' });
    (h.redis.exists as jest.Mock).mockResolvedValue(0);

    await h.service.forgotPassword('u@b.com');

    expect(h.mailService.sendPasswordResetEmail).toHaveBeenCalled();
    const setCall = (h.redis.set as jest.Mock).mock.calls.find(([k]) =>
      String(k).startsWith('pwd-reset-cooldown:u@b.com'),
    );
    expect(setCall).toBeDefined();
    expect(setCall.slice(-2)).toEqual(['EX', 60]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- auth.service`
Expected: FAIL — no cooldown logic.

- [ ] **Step 3: Implement**

`auth.service.ts`:
1. Constants:
```ts
const RESET_COOLDOWN_PREFIX = 'pwd-reset-cooldown:';
const RESET_COOLDOWN_SECONDS = 60;
```
2. `forgotPassword` — after resolving `normalized` email and confirming `user` exists, before signing the token:
```ts
    const cooldownKey = `${RESET_COOLDOWN_PREFIX}${normalized}`;
    if (await this.redis.exists(cooldownKey)) {
      return;
    }
```
3. After `sendPasswordResetEmail(...)`:
```ts
    await this.redis.set(cooldownKey, '1', 'EX', RESET_COOLDOWN_SECONDS);
```
(Order: set the jti key before sending — Task 7 — then send, then set cooldown. All three only run for an existing, non-cooled-down user.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test -- auth.service`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/auth/auth.service.ts src/modules/auth/auth.service.spec.ts
git commit -m "feat(auth): add 60s cooldown to forgot-password email sends"
```

---

## Task 9: Login requires a verified email (#3) + seed + backfill

**Files:**
- Modify: `src/modules/auth/auth.service.ts`
- Modify: `src/modules/auth/auth.service.spec.ts`
- Modify: `prisma/seed.ts`
- Create: `scripts/backfill-email-verified.ts`
- Modify: `package.json` (script)

**Interfaces:**
- Produces: `AuthService.login` — after the password matches and login-failure counter is cleared, if `!user.emailVerifiedAt` it throws `ForbiddenException({ statusCode: 403, error: 'EMAIL_NOT_VERIFIED', message: 'Tài khoản chưa xác thực email. Vui lòng kiểm tra hộp thư hoặc yêu cầu gửi lại mã.' })`.

- [ ] **Step 1: Write the failing tests**

Append to `auth.service.spec.ts`:
```ts
import { ForbiddenException } from '@nestjs/common';

describe('AuthService.login email verification gate', () => {
  const activeUser = {
    id: 'u1',
    email: 'u@b.com',
    password: 'hash',
    role: 'CUSTOMER',
    status: 'ACTIVE',
  };

  beforeEach(() => {
    jest.spyOn(argon2, 'verify').mockResolvedValue(true);
  });
  afterEach(() => jest.restoreAllMocks());

  it('rejects login when emailVerifiedAt is null', async () => {
    const h = createHarness();
    (h.usersService.findByEmailOrPhone as jest.Mock).mockResolvedValue({ ...activeUser, emailVerifiedAt: null });

    await expect(
      h.service.login({ identifier: 'u@b.com', password: 'password1' } as any),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('includes the EMAIL_NOT_VERIFIED marker', async () => {
    const h = createHarness();
    (h.usersService.findByEmailOrPhone as jest.Mock).mockResolvedValue({ ...activeUser, emailVerifiedAt: null });

    await h.service.login({ identifier: 'u@b.com', password: 'password1' } as any).catch((e) => {
      expect(e.getResponse()).toMatchObject({ error: 'EMAIL_NOT_VERIFIED' });
    });
    expect.assertions(1);
  });

  it('allows login when the email is verified', async () => {
    const h = createHarness();
    (h.usersService.findByEmailOrPhone as jest.Mock).mockResolvedValue({ ...activeUser, emailVerifiedAt: new Date() });
    (h.prisma as any).refreshToken.create.mockResolvedValue({});

    const result = await h.service.login({ identifier: 'u@b.com', password: 'password1' } as any);
    expect(result.accessToken).toBeDefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- auth.service`
Expected: FAIL — login currently issues tokens for an unverified user.

- [ ] **Step 3: Implement**

`auth.service.ts` `login()` — locate:
```ts
    await this.clearLoginFailures(identifier);

    const tokens = await this.issueTokens(user);
    return { ...tokens, user: toSafeUser(user) };
```
Change to:
```ts
    await this.clearLoginFailures(identifier);

    if (!user.emailVerifiedAt) {
      throw new ForbiddenException({
        statusCode: 403,
        error: 'EMAIL_NOT_VERIFIED',
        message:
          'Tài khoản chưa xác thực email. Vui lòng kiểm tra hộp thư hoặc yêu cầu gửi lại mã.',
      });
    }

    const tokens = await this.issueTokens(user);
    return { ...tokens, user: toSafeUser(user) };
```
Add `ForbiddenException` to the `@nestjs/common` import.

`prisma/seed.ts` — admin upsert: set verified on both create and update so an existing admin is fixed too:
```ts
  await prisma.user.upsert({
    where: { email: 'admin@clothing-shop.com' },
    update: { emailVerifiedAt: new Date() },
    create: {
      email: 'admin@clothing-shop.com',
      password: adminPasswordHash,
      fullName: 'Quản trị viên',
      role: 'ADMIN',
      emailVerifiedAt: new Date(),
    },
  });
```

`scripts/backfill-email-verified.ts`:
```ts
// Chạy tay 1 lần khi deploy thay đổi "login bắt buộc email đã verify": các tài khoản tạo
// trước đây có emailVerifiedAt = null nhưng vẫn đang dùng bình thường -> coi như đã verify
// (set = createdAt). Đồng thời lowercase email để khớp chuẩn hóa mới.
//   pnpm --filter @clothing-shop/be backfill:email-verified
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const users = await prisma.user.findMany({
    where: { status: 'ACTIVE', emailVerifiedAt: null },
    select: { id: true, email: true, createdAt: true },
  });

  let done = 0;
  let skipped = 0;
  for (const u of users) {
    const normalized = u.email.trim().toLowerCase();
    try {
      await prisma.user.update({
        where: { id: u.id },
        data: { emailVerifiedAt: u.createdAt, email: normalized },
      });
      done += 1;
    } catch (err) {
      // Lowercase gây trùng với 1 email khác (2 tài khoản chỉ khác hoa/thường) — bỏ qua,
      // xử lý tay sau. Vẫn set verify (không đổi email) để không khoá tài khoản.
      await prisma.user.update({
        where: { id: u.id },
        data: { emailVerifiedAt: u.createdAt },
      });
      skipped += 1;
      console.warn(`Email không lowercase được (trùng): ${u.email} — chỉ set verified.`);
    }
  }

  console.log(`Backfill xong: ${done} cập nhật đầy đủ, ${skipped} chỉ set verified.`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
```

`package.json` scripts — add after `"seed"`:
```
"backfill:email-verified": "ts-node scripts/backfill-email-verified.ts",
```

- [ ] **Step 4: Run tests + typecheck**

Run: `pnpm test -- auth.service`
Expected: PASS.
Run: `pnpm build`
Expected: compiles (the script is outside `src` so `nest build` ignores it; verify with `npx tsc --noEmit -p tsconfig.json` if in doubt — it should still typecheck cleanly as it only uses `@prisma/client`).

- [ ] **Step 5: Commit**

```bash
git add src/modules/auth/auth.service.ts src/modules/auth/auth.service.spec.ts prisma/seed.ts scripts/backfill-email-verified.ts package.json
git commit -m "feat(auth): block login until email is verified; add backfill script"
```

---

## Task 10: Security notification emails (#11) + reset template fix

**Files:**
- Modify: `src/modules/mail/templates/email.templates.ts`
- Modify: `src/modules/mail/templates/email.templates.spec.ts`
- Modify: `src/modules/mail/mail.service.ts`
- Modify: `src/modules/auth/auth.service.ts`
- Modify: `src/modules/users/users.service.ts`
- Modify: `src/modules/auth/auth.service.spec.ts`
- Modify: `src/modules/users/users.service.spec.ts`

**Interfaces:**
- Consumes: `maskEmail` from `email.util.ts`.
- Produces on `MailService` (all best-effort — never throw to the caller):
  - `sendPasswordChangedEmail(to: string): Promise<void>`
  - `sendEmailChangedNotice(oldEmail: string, newEmailMasked: string): Promise<void>`
  - `sendPhoneChangedNotice(to: string): Promise<void>`
- Produces templates: `passwordChangedEmailTemplate(): { subject; html }`, `emailChangedNoticeTemplate(newEmailMasked: string): { subject; html }`, `phoneChangedNoticeTemplate(): { subject; html }`.

- [ ] **Step 1: Write the failing tests**

Append to `src/modules/mail/templates/email.templates.spec.ts`:
```ts
import {
  passwordChangedEmailTemplate,
  emailChangedNoticeTemplate,
  phoneChangedNoticeTemplate,
  passwordResetEmailTemplate,
} from './email.templates';

describe('security notice templates', () => {
  it('password changed template mentions the change and support hint', () => {
    const { subject, html } = passwordChangedEmailTemplate();
    expect(subject).toMatch(/mật khẩu/i);
    expect(html).toMatch(/không phải bạn/i);
  });

  it('email changed template shows the masked new address', () => {
    const { html } = emailChangedNoticeTemplate('j******e@example.com');
    expect(html).toContain('j******e@example.com');
  });

  it('phone changed template mentions phone', () => {
    expect(phoneChangedNoticeTemplate().subject).toMatch(/số điện thoại/i);
  });

  it('reset email states the correct 10 minute expiry', () => {
    expect(passwordResetEmailTemplate('https://x/reset?token=t').html).toContain('10 phút');
  });
});
```

Append to `users.service.spec.ts`:
```ts
describe('UsersService change-password notification', () => {
  it('sends a password-changed email after a successful change', async () => {
    const h = createHarness();
    const hash = await argon2.hash('password1');
    (h.prisma.user.findUnique as jest.Mock).mockResolvedValue({ id: 'u1', password: hash, email: 'u@b.com' });
    (h.prisma.user.update as jest.Mock).mockResolvedValue({});
    (h.prisma.refreshToken.updateMany as jest.Mock).mockResolvedValue({});

    await h.service.changePassword('u1', { currentPassword: 'password1', newPassword: 'password2' });

    expect(h.mailService.sendPasswordChangedEmail).toHaveBeenCalledWith('u@b.com');
  });

  it('still succeeds if the notification email throws', async () => {
    const h = createHarness();
    const hash = await argon2.hash('password1');
    (h.prisma.user.findUnique as jest.Mock).mockResolvedValue({ id: 'u1', password: hash, email: 'u@b.com' });
    (h.prisma.user.update as jest.Mock).mockResolvedValue({});
    (h.prisma.refreshToken.updateMany as jest.Mock).mockResolvedValue({});
    (h.mailService.sendPasswordChangedEmail as jest.Mock).mockRejectedValue(new Error('smtp down'));

    await expect(
      h.service.changePassword('u1', { currentPassword: 'password1', newPassword: 'password2' }),
    ).resolves.toMatchObject({ message: expect.any(String) });
  });
});
```
(Because `MailService.sendPasswordChangedEmail` is itself best-effort, the second test proves the method swallows internally — the mock rejecting simulates a non-best-effort call site; keep the call site plain `await`.)

Append to `auth.service.spec.ts`:
```ts
describe('AuthService.resetPassword notification', () => {
  it('emails the user after a successful reset', async () => {
    const h = createHarness();
    jest.spyOn(argon2, 'verify').mockResolvedValue(false);
    (h.jwtService.verifyAsync as jest.Mock).mockResolvedValue({ sub: 'u1', purpose: 'reset-password', jti: 'j1' });
    (h.usersService.findById as jest.Mock).mockResolvedValue({ id: 'u1', password: 'h', email: 'u@b.com' });
    (h.redis.get as jest.Mock).mockResolvedValue('j1');
    (h.usersService.updatePassword as jest.Mock).mockResolvedValue({});

    await h.service.resetPassword('token', 'brandnew1');

    expect(h.mailService.sendPasswordChangedEmail).toHaveBeenCalledWith('u@b.com');
    jest.restoreAllMocks();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- email.templates users.service auth.service`
Expected: FAIL — templates/methods/call-sites do not exist; reset template still says "15 phút".

- [ ] **Step 3: Implement**

`email.templates.ts`:
1. In `passwordResetEmailTemplate`, change `Link có hiệu lực trong 15 phút.` → `Link có hiệu lực trong 10 phút.`
2. Add:
```ts
export function passwordChangedEmailTemplate(): { subject: string; html: string } {
  return {
    subject: 'Mật khẩu của bạn vừa được thay đổi',
    html: layout(
      'Mật khẩu đã thay đổi',
      `<p>Mật khẩu tài khoản Clothing Shop của bạn vừa được thay đổi thành công.</p>
       <p>Nếu <strong>không phải bạn</strong> thực hiện, hãy đặt lại mật khẩu ngay và liên hệ bộ phận hỗ trợ.</p>`,
    ),
  };
}

export function emailChangedNoticeTemplate(newEmailMasked: string): {
  subject: string;
  html: string;
} {
  return {
    subject: 'Email đăng nhập của bạn vừa được thay đổi',
    html: layout(
      'Email đăng nhập đã thay đổi',
      `<p>Email đăng nhập của tài khoản Clothing Shop vừa được đổi sang <strong>${newEmailMasked}</strong>.</p>
       <p>Nếu <strong>không phải bạn</strong> thực hiện, hãy liên hệ bộ phận hỗ trợ ngay — tài khoản của bạn có thể đang bị xâm nhập.</p>`,
    ),
  };
}

export function phoneChangedNoticeTemplate(): { subject: string; html: string } {
  return {
    subject: 'Số điện thoại tài khoản vừa được thay đổi',
    html: layout(
      'Số điện thoại đã thay đổi',
      `<p>Số điện thoại của tài khoản Clothing Shop vừa được cập nhật.</p>
       <p>Nếu <strong>không phải bạn</strong> thực hiện, hãy liên hệ bộ phận hỗ trợ ngay.</p>`,
    ),
  };
}
```

`mail.service.ts`:
1. Import the three templates.
2. Add a private best-effort sender + the three public methods:
```ts
  private async sendBestEffort(to: string, subject: string, html: string): Promise<void> {
    try {
      await this.send(to, subject, html);
    } catch (err) {
      this.logger.warn(
        `Không gửi được email cảnh báo "${subject}" tới ${to}: ${(err as Error).message}`,
      );
    }
  }

  async sendPasswordChangedEmail(to: string): Promise<void> {
    const { subject, html } = passwordChangedEmailTemplate();
    await this.sendBestEffort(to, subject, html);
  }

  async sendEmailChangedNotice(oldEmail: string, newEmailMasked: string): Promise<void> {
    const { subject, html } = emailChangedNoticeTemplate(newEmailMasked);
    await this.sendBestEffort(oldEmail, subject, html);
  }

  async sendPhoneChangedNotice(to: string): Promise<void> {
    const { subject, html } = phoneChangedNoticeTemplate();
    await this.sendBestEffort(to, subject, html);
  }
```

`auth.service.ts` `resetPassword` — after `redis.del(jti key)`:
```ts
    await this.mailService.sendPasswordChangedEmail(user.email);
```

`users.service.ts`:
1. `import { maskEmail } from '../../common/utils/email.util';`
2. `changePassword` — after the `refreshToken.updateMany` revoke, before `return`:
```ts
    await this.mailService.sendPasswordChangedEmail(user.email);
```
3. `confirmEmailChange` — capture the old email before the update and notify it on success:
```ts
  async confirmEmailChange(userId: string, newEmail: string, code: string) {
    const user = await this.findExisting(userId);
    const oldEmail = user.email;
    const normalizedEmail = newEmail.trim().toLowerCase();
    // ... existing consume + update ...
    // after a successful prisma.user.update:
    await this.mailService.sendEmailChangedNotice(oldEmail, maskEmail(normalizedEmail));
    return this.toProfileResponse(updated);
  }
```
(Note the current code calls `await this.findExisting(userId);` without binding — change to `const user = await this.findExisting(userId);`.)
4. `confirmPhoneChange` — after a successful `prisma.user.update`:
```ts
    await this.mailService.sendPhoneChangedNotice(user.email);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test -- email.templates users.service auth.service`
Expected: PASS.

- [ ] **Step 5: Lint + commit**

```bash
pnpm lint
git add src/modules/mail/ src/modules/auth/auth.service.ts src/modules/auth/auth.service.spec.ts src/modules/users/users.service.ts src/modules/users/users.service.spec.ts
git commit -m "feat(auth): send security notification emails on password/email/phone change"
```

---

## Task 11: IP rate limiting via Redis-backed throttler (#1, #2)

**Files:**
- Modify: `package.json` (deps)
- Create: `src/common/throttler/throttler.module.ts`
- Create: `src/common/throttler/vi-throttler.guard.ts`
- Create: `src/common/throttler/vi-throttler.guard.spec.ts`
- Create: `src/common/throttler/redis-throttler.storage.ts` (only if the storage package won't install — see Step 1)
- Modify: `src/app.module.ts`
- Modify: `src/modules/auth/auth.controller.ts`
- Modify: `src/main.ts`
- Modify: `.env.example`

**Interfaces:**
- Produces: `AppThrottlerModule` (global) registering `{ provide: APP_GUARD, useClass: ViThrottlerGuard }`. Global default `THROTTLE_LIMIT` (60) per `THROTTLE_TTL` (60) seconds per IP. Per-route `@Throttle({ default: { limit, ttl } })` on the six auth POST routes. `ThrottlerException` → HTTP 429 with a Vietnamese message.

- [ ] **Step 1: Install dependencies, decide storage**

```bash
pnpm add @nestjs/throttler
pnpm add @nest-lab/throttler-storage-redis
node -e "const t=require('@nestjs/throttler'); console.log('throttler exports:', Object.keys(t).join(','))"
node -e "try{const s=require('@nest-lab/throttler-storage-redis');console.log('storage OK:', Object.keys(s).join(','))}catch(e){console.log('storage MISSING')}"
```
- If `@nest-lab/throttler-storage-redis` installs and prints `storage OK`, use it (Step 3 path A).
- If it prints `storage MISSING` or fails to install, remove it (`pnpm remove @nest-lab/throttler-storage-redis`) and use the local `RedisThrottlerStorage` (Step 3 path B).
- Confirm `ThrottlerStorage` is in the throttler exports list (needed by path B).

- [ ] **Step 2: Write the failing test**

`src/common/throttler/vi-throttler.guard.spec.ts`:
```ts
import { ThrottlerException } from '@nestjs/throttler';
import { ViThrottlerGuard } from './vi-throttler.guard';

describe('ViThrottlerGuard', () => {
  it('throws a Vietnamese ThrottlerException', async () => {
    const guard = Object.create(ViThrottlerGuard.prototype) as ViThrottlerGuard;
    await expect(
      (guard as unknown as { throwThrottlingException: () => Promise<void> }).throwThrottlingException(),
    ).rejects.toBeInstanceOf(ThrottlerException);
    await (guard as unknown as { throwThrottlingException: () => Promise<void> })
      .throwThrottlingException()
      .catch((e: Error) => expect(e.message).toMatch(/quá nhanh|thử lại sau/i));
  });
});
```

- [ ] **Step 3: Implement**

`src/common/throttler/vi-throttler.guard.ts`:
```ts
import { Injectable } from '@nestjs/common';
import { ThrottlerException, ThrottlerGuard } from '@nestjs/throttler';

@Injectable()
export class ViThrottlerGuard extends ThrottlerGuard {
  protected async throwThrottlingException(): Promise<void> {
    throw new ThrottlerException(
      'Bạn thao tác quá nhanh, vui lòng thử lại sau ít phút.',
    );
  }
}
```

**Path B only** — `src/common/throttler/redis-throttler.storage.ts`:
```ts
import { Injectable } from '@nestjs/common';
import type { ThrottlerStorage } from '@nestjs/throttler';
import type Redis from 'ioredis';

interface StorageRecord {
  totalHits: number;
  timeToExpire: number;
  isBlocked: boolean;
  timeToBlockExpire: number;
}

// Lưu bộ đếm request theo key ở Redis để rate limit đúng khi chạy nhiều instance.
// TTL/blockDuration nhận vào theo mili giây (giao ước của @nestjs/throttler v6).
@Injectable()
export class RedisThrottlerStorage implements ThrottlerStorage {
  constructor(private readonly redis: Redis) {}

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<StorageRecord> {
    const hitKey = `throttle:${throttlerName}:${key}`;
    const blockKey = `throttle:${throttlerName}:${key}:blocked`;

    const blockPttl = await this.redis.pttl(blockKey);
    if (blockPttl > 0) {
      const s = Math.ceil(blockPttl / 1000);
      return { totalHits: limit + 1, timeToExpire: s, isBlocked: true, timeToBlockExpire: s };
    }

    const totalHits = await this.redis.incr(hitKey);
    let pttl = await this.redis.pttl(hitKey);
    if (pttl < 0) {
      await this.redis.pexpire(hitKey, ttl);
      pttl = ttl;
    }

    if (totalHits > limit) {
      const blockSeconds = Math.ceil(blockDuration / 1000);
      await this.redis.set(blockKey, '1', 'EX', Math.max(blockSeconds, 1));
      return {
        totalHits,
        timeToExpire: Math.ceil(pttl / 1000),
        isBlocked: true,
        timeToBlockExpire: blockSeconds,
      };
    }

    return {
      totalHits,
      timeToExpire: Math.ceil(pttl / 1000),
      isBlocked: false,
      timeToBlockExpire: 0,
    };
  }
}
```

`src/common/throttler/throttler.module.ts`:
```ts
import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import type Redis from 'ioredis';
import { REDIS_CLIENT } from '../../config/redis.module';
import { ViThrottlerGuard } from './vi-throttler.guard';
// Path A:
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
// Path B: import { RedisThrottlerStorage } from './redis-throttler.storage';

@Global()
@Module({
  imports: [
    ThrottlerModule.forRootAsync({
      inject: [ConfigService, REDIS_CLIENT],
      useFactory: (config: ConfigService, redis: Redis) => ({
        throttlers: [
          {
            ttl: Number(config.get<string>('THROTTLE_TTL', '60')) * 1000,
            limit: Number(config.get<string>('THROTTLE_LIMIT', '60')),
          },
        ],
        storage: new ThrottlerStorageRedisService(redis),
        // Path B: storage: new RedisThrottlerStorage(redis),
      }),
    }),
  ],
  providers: [{ provide: APP_GUARD, useClass: ViThrottlerGuard }],
})
export class AppThrottlerModule {}
```

`src/app.module.ts` — add `AppThrottlerModule` to `imports` right after `RedisModule`, with `import { AppThrottlerModule } from './common/throttler/throttler.module';`.

`src/modules/auth/auth.controller.ts` — `import { Throttle } from '@nestjs/throttler';` then add above each handler:
```ts
  @Post('register')
  @Throttle({ default: { limit: 5, ttl: 600_000 } })
  ...
  @Post('verify-otp')
  @Throttle({ default: { limit: 10, ttl: 300_000 } })
  ...
  @Post('resend-otp')
  @Throttle({ default: { limit: 5, ttl: 900_000 } })
  ...
  @Post('login')
  @Throttle({ default: { limit: 10, ttl: 300_000 } })
  ...
  @Post('forgot-password')
  @Throttle({ default: { limit: 5, ttl: 900_000 } })
  ...
  @Post('reset-password')
  @Throttle({ default: { limit: 10, ttl: 300_000 } })
  ...
```
(`logout`, `refresh`, `me` keep the global default.)

`src/main.ts` — after `app.use(helmet());`:
```ts
  if (process.env.TRUST_PROXY === 'true') {
    app.getHttpAdapter().getInstance().set('trust proxy', 1);
  }
```

`.env.example` — add near the JWT block:
```
# Rate limiting (mỗi IP)
THROTTLE_TTL=60
THROTTLE_LIMIT=60
# Bật khi backend chạy sau reverse proxy (nginx/ELB) để lấy đúng IP client từ X-Forwarded-For
TRUST_PROXY=false
```

- [ ] **Step 4: Run test + build**

Run: `pnpm test -- vi-throttler`
Expected: PASS.
Run: `pnpm build`
Expected: compiles.

- [ ] **Step 5: Commit**

```bash
git add package.json pnpm-lock.yaml src/common/throttler/ src/app.module.ts src/modules/auth/auth.controller.ts src/main.ts .env.example
git commit -m "feat(auth): add Redis-backed IP rate limiting on auth endpoints"
```

Note on #2 (register email enumeration): no code change — `register` keeps returning `409 'Email đã được sử dụng'` by decision; the `@Throttle` on `POST /auth/register` (5 / 10 min) is the mitigation.

---

## Task 12: Fill remaining unit coverage for AuthService & OtpService (#12 unit)

**Files:**
- Modify: `src/modules/auth/auth.service.spec.ts`
- Modify: `src/common/otp/otp.service.spec.ts`

**Interfaces:**
- Consumes: `createHarness` from `auth.service.spec.ts`.
- Produces: no production code — coverage sweep for methods not yet exercised.

- [ ] **Step 1: Add the missing test cases**

Append to `auth.service.spec.ts`:
```ts
describe('AuthService.register', () => {
  it('rejects a duplicate email with 409', async () => {
    const h = createHarness();
    (h.usersService.findByEmail as jest.Mock).mockResolvedValue({ id: 'x' });
    await expect(
      h.service.register({ email: 'u@b.com', password: 'password1', fullName: 'U' } as any),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('rejects a duplicate phone with 409', async () => {
    const h = createHarness();
    (h.usersService.findByEmail as jest.Mock).mockResolvedValue(null);
    (h.usersService.findByPhone as jest.Mock).mockResolvedValue({ id: 'x' });
    await expect(
      h.service.register({ email: 'u@b.com', password: 'password1', fullName: 'U', phone: '0901234567' } as any),
    ).rejects.toMatchObject({ status: 409 });
  });
});

describe('AuthService.verifyOtp', () => {
  it('marks the email verified and sends the welcome email on a correct code', async () => {
    const h = createHarness();
    (h.usersService.findByEmail as jest.Mock).mockResolvedValue({ id: 'u1', email: 'u@b.com', fullName: 'U' });
    (h.otpService.consume as jest.Mock).mockResolvedValue(true);
    (h.mailService as any).sendWelcomeEmail = jest.fn();

    await h.service.verifyOtp('u@b.com', '123456');

    expect(h.usersService.markEmailVerified).toHaveBeenCalledWith('u1');
    expect((h.mailService as any).sendWelcomeEmail).toHaveBeenCalled();
  });

  it('rejects a wrong code with 400', async () => {
    const h = createHarness();
    (h.usersService.findByEmail as jest.Mock).mockResolvedValue({ id: 'u1', email: 'u@b.com' });
    (h.otpService.consume as jest.Mock).mockResolvedValue(false);
    await expect(h.service.verifyOtp('u@b.com', '000000')).rejects.toMatchObject({ status: 400 });
  });

  it('rejects an unknown email with 400 (no user enumeration)', async () => {
    const h = createHarness();
    (h.usersService.findByEmail as jest.Mock).mockResolvedValue(null);
    await expect(h.service.verifyOtp('nobody@b.com', '123456')).rejects.toMatchObject({ status: 400 });
  });
});

describe('AuthService.resendOtp', () => {
  it('sends a new code for an existing user', async () => {
    const h = createHarness();
    (h.usersService.findByEmail as jest.Mock).mockResolvedValue({ id: 'u1', email: 'u@b.com' });
    await h.service.resendOtp('u@b.com');
    expect(h.otpService.send).toHaveBeenCalledWith('register', 'u@b.com');
  });

  it('stays silent for an unknown email', async () => {
    const h = createHarness();
    (h.usersService.findByEmail as jest.Mock).mockResolvedValue(null);
    const res = await h.service.resendOtp('nobody@b.com');
    expect(h.otpService.send).not.toHaveBeenCalled();
    expect(res.message).toMatch(/nếu email tồn tại/i);
  });
});

describe('AuthService.login failures', () => {
  it('locks out after too many failures', async () => {
    const h = createHarness();
    (h.redis.get as jest.Mock).mockResolvedValue('5');
    await expect(
      h.service.login({ identifier: 'u@b.com', password: 'password1' } as any),
    ).rejects.toMatchObject({ status: 401 });
  });

  it('rejects a non-active account with a generic 401', async () => {
    const h = createHarness();
    (h.redis.get as jest.Mock).mockResolvedValue(null);
    (h.usersService.findByEmailOrPhone as jest.Mock).mockResolvedValue({
      id: 'u1', email: 'u@b.com', password: 'h', status: 'BANNED', emailVerifiedAt: new Date(),
    });
    await expect(
      h.service.login({ identifier: 'u@b.com', password: 'password1' } as any),
    ).rejects.toMatchObject({ status: 401 });
  });
});

describe('AuthService.refreshTokens', () => {
  it('rejects an invalid refresh token', async () => {
    const h = createHarness();
    (h.jwtService.verifyAsync as jest.Mock).mockRejectedValue(new Error('bad'));
    await expect(h.service.refreshTokens('nope')).rejects.toMatchObject({ status: 401 });
  });
});

describe('AuthService.logout', () => {
  it('silently ignores an invalid token', async () => {
    const h = createHarness();
    (h.jwtService.verifyAsync as jest.Mock).mockRejectedValue(new Error('bad'));
    await expect(h.service.logout('nope')).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests**

Run: `pnpm test -- auth.service otp.service`
Expected: PASS (all).

- [ ] **Step 3: Check coverage**

Run: `pnpm test -- --coverage --collectCoverageFrom='src/modules/auth/auth.service.ts' --collectCoverageFrom='src/common/otp/otp.service.ts' auth.service otp.service`
Expected: both files ≥ 90% statements. If a branch is uncovered, add a targeted test.

- [ ] **Step 4: Commit**

```bash
git add src/modules/auth/auth.service.spec.ts src/common/otp/otp.service.spec.ts
git commit -m "test(auth): cover register/verify/resend/login/refresh/logout paths"
```

---

## Task 13: e2e — auth flows (#12 e2e)

**Files:**
- Create: `test/auth.e2e-spec.ts`

**Interfaces:**
- Consumes: `AppModule`, `PrismaService`, `REDIS_CLIENT`, `MailService` (overridden with a fake to capture the reset link and assert notifications).

- [ ] **Step 1: Write the e2e spec**

`test/auth.e2e-spec.ts`:
```ts
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import Redis from 'ioredis';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/config/prisma.service';
import { REDIS_CLIENT } from '../src/config/redis.module';
import { MailService } from '../src/modules/mail/mail.service';
import { AllExceptionsFilter } from '../src/common/filters/http-exception.filter';

interface SentMail {
  method: string;
  args: unknown[];
}

describe('Auth (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let redis: Redis;
  const sent: SentMail[] = [];
  const tag = `auth-e2e-${Date.now()}`;
  const email = `${tag}@example.com`;
  const createdEmails: string[] = [];

  const fakeMail: Partial<Record<keyof MailService, jest.Mock>> = {
    sendOtpEmail: jest.fn((...args) => sent.push({ method: 'sendOtpEmail', args })),
    sendWelcomeEmail: jest.fn((...args) => sent.push({ method: 'sendWelcomeEmail', args })),
    sendPasswordResetEmail: jest.fn((...args) => sent.push({ method: 'sendPasswordResetEmail', args })),
    sendPasswordChangedEmail: jest.fn((...args) => sent.push({ method: 'sendPasswordChangedEmail', args })),
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(MailService)
      .useValue(fakeMail)
      .compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();

    prisma = moduleFixture.get(PrismaService);
    redis = moduleFixture.get(REDIS_CLIENT);
  });

  afterAll(async () => {
    if (createdEmails.length) {
      await prisma.user.deleteMany({ where: { email: { in: createdEmails } } });
    }
    for (const e of createdEmails) {
      await redis.del(`otp:register:${e}`, `otp-resend:register:${e}`);
    }
    await app.close();
  });

  async function readOtp(forEmail: string): Promise<string> {
    const raw = await redis.get(`otp:register:${forEmail}`);
    if (!raw) throw new Error('OTP not found in Redis');
    return (JSON.parse(raw) as { code: string }).code;
  }

  it('register -> verify-otp -> login happy path', async () => {
    createdEmails.push(email);

    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password: 'password1', fullName: 'Auth E2E' })
      .expect(201);

    const code = await readOtp(email);

    await request(app.getHttpServer())
      .post('/auth/verify-otp')
      .send({ email, code })
      .expect(200);

    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ identifier: email, password: 'password1' })
      .expect(200);

    expect(res.body.accessToken).toBeDefined();
    expect(res.body.refreshToken).toBeDefined();
  });

  it('login before verification returns 403 EMAIL_NOT_VERIFIED', async () => {
    const e2 = `${tag}-unverified@example.com`;
    createdEmails.push(e2);

    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email: e2, password: 'password1', fullName: 'Unverified' })
      .expect(201);

    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ identifier: e2, password: 'password1' })
      .expect(403);

    expect(res.body.error).toBe('EMAIL_NOT_VERIFIED');
  });

  it('forgot-password -> reset-password -> login with new password; token cannot be reused', async () => {
    // uses the verified account from the first test
    await request(app.getHttpServer())
      .post('/auth/forgot-password')
      .send({ email })
      .expect(200);

    const resetCall = [...sent].reverse().find((m) => m.method === 'sendPasswordResetEmail');
    expect(resetCall).toBeDefined();
    const link = resetCall!.args[1] as string;
    const token = new URL(link).searchParams.get('token')!;
    expect(token).toBeTruthy();

    await request(app.getHttpServer())
      .post('/auth/reset-password')
      .send({ token, newPassword: 'password2' })
      .expect(200);

    await request(app.getHttpServer())
      .post('/auth/login')
      .send({ identifier: email, password: 'password2' })
      .expect(200);

    // reuse -> 400
    await request(app.getHttpServer())
      .post('/auth/reset-password')
      .send({ token, newPassword: 'password3' })
      .expect(400);

    expect(sent.some((m) => m.method === 'sendPasswordChangedEmail')).toBe(true);
  });

  it('forgot-password is silent for an unknown email', async () => {
    await request(app.getHttpServer())
      .post('/auth/forgot-password')
      .send({ email: `${tag}-nobody@example.com` })
      .expect(200);
  });
});
```

- [ ] **Step 2: Run the e2e spec**

Run: `pnpm test:e2e -- auth.e2e`
Expected: PASS. Requires a running Postgres (matching `DATABASE_URL`/`DIRECT_URL`) and Redis (`REDIS_URL`) — same prerequisites as `test/orders.e2e-spec.ts`.

- [ ] **Step 3: Commit**

```bash
git add test/auth.e2e-spec.ts
git commit -m "test(auth): e2e for register/verify/login, forgot/reset, verification gate"
```

---

## Task 14: e2e — rate limiting (#1 integration)

**Files:**
- Create: `test/auth-throttle.e2e-spec.ts`

**Interfaces:**
- Consumes: `AppModule`, `REDIS_CLIENT`. Throttler runs for real (not overridden).

- [ ] **Step 1: Write the e2e spec**

`test/auth-throttle.e2e-spec.ts`:
```ts
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import Redis from 'ioredis';
import { AppModule } from '../src/app.module';
import { REDIS_CLIENT } from '../src/config/redis.module';
import { MailService } from '../src/modules/mail/mail.service';
import { AllExceptionsFilter } from '../src/common/filters/http-exception.filter';

describe('Auth throttling (e2e)', () => {
  let app: INestApplication<App>;
  let redis: Redis;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(MailService)
      .useValue({ sendOtpEmail: jest.fn(), sendWelcomeEmail: jest.fn() })
      .compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();

    redis = moduleFixture.get(REDIS_CLIENT);
    // clear any throttle counters for this test's IP bucket
    const keys = await redis.keys('throttle:*');
    if (keys.length) await redis.del(...keys);
  });

  afterAll(async () => {
    const keys = await redis.keys('throttle:*');
    if (keys.length) await redis.del(...keys);
    await app.close();
  });

  it('returns 429 after exceeding the register limit (5 / 10 min)', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) {
      const res = await request(app.getHttpServer())
        .post('/auth/register')
        .send({ email: `throttle-${Date.now()}-${i}@example.com`, password: 'password1', fullName: 'T' });
      statuses.push(res.status);
    }
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);
    expect(statuses[statuses.length - 1]).toBe(429);
  });
});
```
Note: `.keys('throttle:*')` matches both path A (`ThrottlerStorageRedisService`, keys prefixed differently — adjust the glob to `*throttle*` if path A was chosen and keys don't match) and path B. Verify the actual key prefix once with `redis-cli KEYS '*'` during the first run and fix the glob.

- [ ] **Step 2: Run the e2e spec**

Run: `pnpm test:e2e -- auth-throttle.e2e`
Expected: PASS. If the register happy-path users leak, add `afterAll` cleanup `prisma.user.deleteMany({ where: { email: { contains: 'throttle-' } } })` (inject `PrismaService`).

- [ ] **Step 3: Commit**

```bash
git add test/auth-throttle.e2e-spec.ts
git commit -m "test(auth): e2e proving register endpoint rate limit returns 429"
```

---

## Task 15: Full verification + spec cross-check

**Files:** none (verification only; small fixes as needed).

- [ ] **Step 1: Lint**

Run: `pnpm lint`
Expected: exit 0, no errors.

- [ ] **Step 2: Build**

Run: `pnpm build`
Expected: exit 0.

- [ ] **Step 3: Full unit test run**

Run: `pnpm test`
Expected: all suites pass.

- [ ] **Step 4: Full e2e run**

Run: `pnpm test:e2e`
Expected: all e2e suites pass (auth, auth-throttle, orders, orders-payments, internal-orders, app). If the global throttler (60/60s/IP) trips an existing suite, raise `THROTTLE_LIMIT` via that suite's env or add `@SkipThrottle()` to the specific non-auth route; re-run.

- [ ] **Step 5: Cross-check against the spec**

Open `docs/superpowers/specs/2026-09-04-auth-hardening-design.md`. For each of the 12 items, confirm a commit implements it:
1. throttler module + per-route + trust proxy — Task 11
2. register keeps 409 + throttle — Task 11 (note)
3. login verify gate + seed + backfill — Task 9
4. forgot cooldown — Task 8
5. reset jti single-use — Task 7
6. reset secret — Task 6
7. min-length 8 + no reuse — Tasks 4, 5
8. email normalize — Tasks 1, 2
9. OTP CSPRNG — Task 3
10. register phone regex — Task 4
11. security notice emails + "10 phút" fix — Task 10
12. unit + e2e — Tasks 12, 13, 14

- [ ] **Step 6: Review the full diff**

Run: `git diff fix-develop...HEAD --stat` then read the full diff against `CLAUDE.md` conventions (module structure, DTO validation, error handling, no leaked internals, `ConfigService` for secrets, `.env.example` updated). Confirm `vendor/backend-cms` is NOT in the diff.

- [ ] **Step 7: Report**

Summarize to the user: what changed, any deviations from the plan, test/lint/build results with actual output, and remind them the branch is `fix/auth-hardening` (not pushed).

---

## Self-Review

**Spec coverage:** All 12 spec items map to a task (see Task 15 Step 5). The 4 deferred items (A/B/C/D) are explicitly out of scope and have no task — correct.

**Placeholder scan:** No "TBD"/"handle edge cases"/"similar to Task N". Each code step has real code. Task 11 has two explicit implementation paths (A/B) chosen by a verification command in Step 1 — not a placeholder, a decision procedure with both outcomes fully specified.

**Type consistency:**
- `normalizeEmail` / `maskEmail` — signatures identical in Task 1 (defined), Task 2 (used), Task 10 (used).
- `AuthService` constructor arg order (usersService, prisma, jwtService, config, mailService, otpService, redis) — matches the real file read during planning; `createHarness` in Task 2 mirrors it and is reused by Tasks 5–12.
- `UsersService` constructor gains `mailService` in Task 5; `users.service.spec.ts` `createHarness` (Task 5) passes 3 args from the start; `users.module.ts` imports `MailModule` in the same task — consistent.
- `MailService.sendPasswordChangedEmail(to)` / `sendEmailChangedNotice(oldEmail, newEmailMasked)` / `sendPhoneChangedNotice(to)` — defined in Task 10, referenced only in Task 10 call sites and the Task 5/10 spec harnesses (as jest mocks, arg count matches).
- Redis reset keys: `pwd-reset-jti:<userId>` (Task 7), `pwd-reset-cooldown:<email>` (Task 8) — prefixes are distinct constants, used consistently in impl + tests + e2e cleanup.
- `@Throttle` ttl values are milliseconds (throttler v6) — consistent across all six routes.

**Scope check:** Single subsystem (auth hardening on backend-user). One plan is right.
