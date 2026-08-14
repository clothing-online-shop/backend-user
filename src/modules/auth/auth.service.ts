import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import { User } from '@prisma/client';
import type Redis from 'ioredis';
import { PrismaService } from '../../config/prisma.service';
import { REDIS_CLIENT } from '../../config/redis.module';
import { UsersService } from '../users/users.service';
import { MailService } from '../mail/mail.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { JwtPayload } from './strategies/jwt.strategy';

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

const RESET_TOKEN_PURPOSE = 'reset-password';

const OTP_TTL_SECONDS = 5 * 60;
const OTP_MAX_ATTEMPTS = 5;
const OTP_RESEND_COOLDOWN_SECONDS = 60;
const LOGIN_LOCKOUT_TTL_SECONDS = 15 * 60;
const LOGIN_MAX_ATTEMPTS = 5;

interface StoredOtp {
  code: string;
  attempts: number;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly usersService: UsersService,
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly config: ConfigService,
    private readonly mailService: MailService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  async register(dto: RegisterDto): Promise<Omit<User, 'password'>> {
    const existingByEmail = await this.usersService.findByEmail(dto.email);
    if (existingByEmail) {
      throw new ConflictException('Email đã được sử dụng');
    }

    if (dto.phone) {
      const existingByPhone = await this.usersService.findByPhone(dto.phone);
      if (existingByPhone) {
        throw new ConflictException('Số điện thoại đã được sử dụng');
      }
    }

    const passwordHash = await argon2.hash(dto.password);
    const user = await this.usersService.create({
      email: dto.email,
      passwordHash,
      fullName: dto.fullName,
      phone: dto.phone,
    });

    // Email chào mừng dời sang lúc verify-otp thành công — lúc này tài khoản chưa xác
    // thực, "chào mừng" đúng lúc account đã thật hơn là ngay khi vừa tạo.
    await this.sendOtp(user.email);

    return toSafeUser(user);
  }

  async verifyOtp(email: string, code: string): Promise<{ message: string }> {
    const user = await this.usersService.findByEmail(email);
    if (!user) {
      throw new BadRequestException('Mã OTP không đúng hoặc đã hết hạn.');
    }

    const valid = await this.consumeOtp(email, code);
    if (!valid) {
      throw new BadRequestException('Mã OTP không đúng hoặc đã hết hạn.');
    }

    await this.usersService.markEmailVerified(user.id);
    await this.mailService.sendWelcomeEmail(user.email, user.fullName);

    return { message: 'Xác thực email thành công.' };
  }

  async resendOtp(email: string): Promise<{ message: string }> {
    const cooldownKey = otpResendCooldownKey(email);
    if (await this.redis.exists(cooldownKey)) {
      throw new BadRequestException(
        'Vui lòng đợi một chút trước khi gửi lại mã.',
      );
    }

    // Không tiết lộ email có tồn tại hay không — cùng nguyên tắc với forgotPassword.
    const user = await this.usersService.findByEmail(email);
    if (user) {
      await this.sendOtp(email);
    }

    return { message: 'Nếu email tồn tại, mã OTP mới đã được gửi.' };
  }

  async login(
    dto: LoginDto,
  ): Promise<AuthTokens & { user: Omit<User, 'password'> }> {
    const identifier = dto.identifier.trim().toLowerCase();
    await this.assertNotLocked(identifier);

    const user = await this.usersService.findByEmailOrPhone(dto.identifier);
    if (!user) {
      await this.recordLoginFailure(identifier);
      throw new UnauthorizedException('Email/SĐT hoặc mật khẩu không đúng');
    }

    const passwordMatches = await argon2.verify(user.password, dto.password);
    if (!passwordMatches) {
      await this.recordLoginFailure(identifier);
      throw new UnauthorizedException('Email/SĐT hoặc mật khẩu không đúng');
    }

    await this.clearLoginFailures(identifier);

    const tokens = await this.issueTokens(user);
    return { ...tokens, user: toSafeUser(user) };
  }

  async logout(refreshToken: string): Promise<void> {
    let payload: { sub: string };
    try {
      payload = await this.jwtService.verifyAsync(refreshToken, {
        secret: this.config.get<string>(
          'JWT_REFRESH_SECRET',
          'change-me-refresh-secret',
        ),
      });
    } catch {
      // Token không hợp lệ/hết hạn — coi như đã đăng xuất, không cần báo lỗi cho client.
      return;
    }

    const candidates = await this.prisma.refreshToken.findMany({
      where: { userId: payload.sub, revoked: false },
    });

    for (const candidate of candidates) {
      if (await argon2.verify(candidate.tokenHash, refreshToken)) {
        await this.prisma.refreshToken.update({
          where: { id: candidate.id },
          data: { revoked: true },
        });
        return;
      }
    }
  }

  async refreshTokens(refreshToken: string): Promise<AuthTokens> {
    let payload: { sub: string };
    try {
      payload = await this.jwtService.verifyAsync(refreshToken, {
        secret: this.config.get<string>(
          'JWT_REFRESH_SECRET',
          'change-me-refresh-secret',
        ),
      });
    } catch {
      throw new UnauthorizedException('Refresh token không hợp lệ');
    }

    const candidates = await this.prisma.refreshToken.findMany({
      where: {
        userId: payload.sub,
        revoked: false,
        expiresAt: { gt: new Date() },
      },
    });

    let matchedTokenId: string | null = null;
    for (const candidate of candidates) {
      if (await argon2.verify(candidate.tokenHash, refreshToken)) {
        matchedTokenId = candidate.id;
        break;
      }
    }

    if (!matchedTokenId) {
      throw new UnauthorizedException(
        'Refresh token không hợp lệ hoặc đã bị thu hồi',
      );
    }

    const user = await this.usersService.findById(payload.sub);
    if (!user) {
      throw new UnauthorizedException('Người dùng không tồn tại');
    }

    await this.prisma.refreshToken.update({
      where: { id: matchedTokenId },
      data: { revoked: true },
    });

    return this.issueTokens(user);
  }

  async forgotPassword(email: string): Promise<void> {
    const user = await this.usersService.findByEmail(email);
    if (!user) {
      this.logger.warn(`Forgot-password requested for unknown email: ${email}`);
      return;
    }

    const resetToken = await this.jwtService.signAsync(
      { sub: user.id, purpose: RESET_TOKEN_PURPOSE },
      {
        secret: this.config.get<string>(
          'JWT_SECRET',
          'change-me-access-secret',
        ),
        // Rút từ 15 phút xuống 10 phút — khớp yêu cầu "hiệu lực 5-10 phút" của task quên
        // mật khẩu (chọn cận trên cho đỡ gấp gáp với người dùng thật).
        expiresIn: '10m',
      },
    );

    const webOrigin = this.config.get<string>(
      'WEB_ORIGIN',
      'http://localhost:3000',
    );
    const resetLink = `${webOrigin}/reset-password?token=${resetToken}`;
    await this.mailService.sendPasswordResetEmail(email, resetLink);
  }

  async resetPassword(token: string, newPassword: string): Promise<void> {
    let payload: { sub: string; purpose: string };
    try {
      payload = await this.jwtService.verifyAsync(token, {
        secret: this.config.get<string>(
          'JWT_SECRET',
          'change-me-access-secret',
        ),
      });
    } catch {
      throw new BadRequestException(
        'Token đặt lại mật khẩu không hợp lệ hoặc đã hết hạn',
      );
    }

    if (payload.purpose !== RESET_TOKEN_PURPOSE) {
      throw new BadRequestException('Token đặt lại mật khẩu không hợp lệ');
    }

    const passwordHash = await argon2.hash(newPassword);
    await this.usersService.updatePassword(payload.sub, passwordHash);

    await this.prisma.refreshToken.updateMany({
      where: { userId: payload.sub, revoked: false },
      data: { revoked: true },
    });
  }

  private async issueTokens(user: User): Promise<AuthTokens> {
    const payload: JwtPayload = {
      sub: user.id,
      email: user.email,
      role: user.role,
    };

    const accessToken = await this.jwtService.signAsync(payload, {
      secret: this.config.get<string>('JWT_SECRET', 'change-me-access-secret'),
      expiresIn: asExpiresIn(
        this.config.get<string>('JWT_ACCESS_EXPIRES_IN', '15m'),
      ),
    });

    const refreshExpiresIn = this.config.get<string>(
      'JWT_REFRESH_EXPIRES_IN',
      '7d',
    );
    const refreshToken = await this.jwtService.signAsync(
      { sub: user.id },
      {
        secret: this.config.get<string>(
          'JWT_REFRESH_SECRET',
          'change-me-refresh-secret',
        ),
        expiresIn: asExpiresIn(refreshExpiresIn),
      },
    );

    const tokenHash = await argon2.hash(refreshToken);
    await this.prisma.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash,
        expiresAt: new Date(Date.now() + parseDurationMs(refreshExpiresIn)),
      },
    });

    return { accessToken, refreshToken };
  }

  // ---- OTP (Redis, TTL 5 phút) ----

  private async sendOtp(email: string): Promise<void> {
    const code = generateOtpCode();
    const stored: StoredOtp = { code, attempts: 0 };
    await this.redis.set(
      otpKey(email),
      JSON.stringify(stored),
      'EX',
      OTP_TTL_SECONDS,
    );
    await this.redis.set(
      otpResendCooldownKey(email),
      '1',
      'EX',
      OTP_RESEND_COOLDOWN_SECONDS,
    );
    await this.mailService.sendOtpEmail(email, code);
  }

  // Sai quá OTP_MAX_ATTEMPTS lần trong 1 lượt OTP thì hủy hẳn mã đó (dù còn hạn) — chống
  // dò mã 6 số (1 triệu khả năng) ngay trong 5 phút hiệu lực, buộc phải gửi lại mã mới.
  private async consumeOtp(email: string, code: string): Promise<boolean> {
    const key = otpKey(email);
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

  // ---- Khóa tạm đăng nhập (Redis, TTL 15 phút kể từ lần sai đầu tiên) ----

  private async assertNotLocked(identifier: string): Promise<void> {
    const attempts = await this.redis.get(loginFailKey(identifier));
    if (attempts && Number(attempts) >= LOGIN_MAX_ATTEMPTS) {
      throw new UnauthorizedException(
        'Tài khoản tạm khóa do đăng nhập sai quá 5 lần, vui lòng thử lại sau ít phút.',
      );
    }
  }

  private async recordLoginFailure(identifier: string): Promise<void> {
    const key = loginFailKey(identifier);
    const attempts = await this.redis.incr(key);
    if (attempts === 1) {
      await this.redis.expire(key, LOGIN_LOCKOUT_TTL_SECONDS);
    }
  }

  private async clearLoginFailures(identifier: string): Promise<void> {
    await this.redis.del(loginFailKey(identifier));
  }
}

function otpKey(email: string): string {
  return `otp:register:${email.toLowerCase()}`;
}

function otpResendCooldownKey(email: string): string {
  return `otp-resend:${email.toLowerCase()}`;
}

function loginFailKey(identifier: string): string {
  return `login-fail:${identifier.toLowerCase()}`;
}

function generateOtpCode(): string {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function asExpiresIn(value: string): `${number}${'s' | 'm' | 'h' | 'd'}` {
  return value as `${number}${'s' | 'm' | 'h' | 'd'}`;
}

function toSafeUser(user: User): Omit<User, 'password'> {
  const safeUser: Partial<User> = { ...user };
  delete safeUser.password;
  return safeUser as Omit<User, 'password'>;
}

function parseDurationMs(duration: string): number {
  const match = /^(\d+)([smhd])$/.exec(duration);
  if (!match) return 7 * 24 * 60 * 60 * 1000;

  const value = Number(match[1]);
  const unitMs =
    { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2]] ?? 86_400_000;
  return value * unitMs;
}
