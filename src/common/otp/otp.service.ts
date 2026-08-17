import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import type Redis from 'ioredis';
import { REDIS_CLIENT } from '../../config/redis.module';
import { MailService } from '../../modules/mail/mail.service';

const OTP_TTL_SECONDS = 5 * 60;
const OTP_MAX_ATTEMPTS = 5;
const OTP_RESEND_COOLDOWN_SECONDS = 60;

interface StoredOtp {
  code: string;
  attempts: number;
}

// Dùng chung cho mọi luồng cần xác thực qua OTP gửi email (đăng ký, đổi email, đổi SĐT...)
// — tách khỏi AuthService (nơi cơ chế này ra đời ban đầu cho luồng đăng ký) vì UsersModule
// (đổi email/SĐT) cần dùng lại y hệt cơ chế, namespace theo `purpose` để các luồng không
// đụng OTP của nhau (vd tài khoản vừa đổi email vừa đổi SĐT cùng lúc không lẫn mã).
@Injectable()
export class OtpService {
  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly mailService: MailService,
  ) {}

  async send(purpose: string, email: string): Promise<void> {
    const cooldownKey = this.resendCooldownKey(purpose, email);
    if (await this.redis.exists(cooldownKey)) {
      throw new BadRequestException(
        'Vui lòng đợi một chút trước khi gửi lại mã.',
      );
    }

    const code = generateOtpCode();
    const stored: StoredOtp = { code, attempts: 0 };
    await this.redis.set(
      this.otpKey(purpose, email),
      JSON.stringify(stored),
      'EX',
      OTP_TTL_SECONDS,
    );
    await this.redis.set(cooldownKey, '1', 'EX', OTP_RESEND_COOLDOWN_SECONDS);
    await this.mailService.sendOtpEmail(email, code);
  }

  // Sai quá OTP_MAX_ATTEMPTS lần trong 1 lượt OTP thì hủy hẳn mã đó (dù còn hạn) — chống
  // dò mã 6 số (1 triệu khả năng) ngay trong 5 phút hiệu lực, buộc phải gửi lại mã mới.
  async consume(
    purpose: string,
    email: string,
    code: string,
  ): Promise<boolean> {
    const key = this.otpKey(purpose, email);
    const raw = await this.redis.get(key);
    if (!raw) return false;

    const stored = JSON.parse(raw) as StoredOtp;
    if (stored.code !== code) {
      stored.attempts += 1;
      if (stored.attempts >= OTP_MAX_ATTEMPTS) {
        await this.redis.del(key);
      } else {
        await this.redis.set(key, JSON.stringify(stored), 'KEEPTTL');
      }
      return false;
    }

    await this.redis.del(key);
    return true;
  }

  private otpKey(purpose: string, email: string): string {
    return `otp:${purpose}:${email.toLowerCase()}`;
  }

  private resendCooldownKey(purpose: string, email: string): string {
    return `otp-resend:${purpose}:${email.toLowerCase()}`;
  }
}

function generateOtpCode(): string {
  return Math.floor(100000 + Math.random() * 900000).toString();
}
