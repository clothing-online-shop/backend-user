import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import { User, UserStatus } from '@prisma/client';
import type Redis from 'ioredis';
import { PrismaService } from '../../config/prisma.service';
import { REDIS_CLIENT } from '../../config/redis.module';
import { UsersService } from '../users/users.service';
import { MailService } from '../mail/mail.service';
import { OtpService } from '../../common/otp/otp.service';
import { toSafeUser } from '../../common/utils/safe-user.util';
import { normalizeEmail } from '../../common/utils/email.util';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { JwtPayload } from './strategies/jwt.strategy';

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

const RESET_TOKEN_PURPOSE = 'reset-password';
const RESET_TOKEN_SECRET_KEY = 'JWT_RESET_SECRET';
const RESET_TOKEN_SECRET_DEFAULT = 'change-me-reset-secret';
const RESET_JTI_PREFIX = 'pwd-reset-jti:';
const RESET_TOKEN_TTL_SECONDS = 10 * 60;
const RESET_COOLDOWN_PREFIX = 'pwd-reset-cooldown:';
const RESET_COOLDOWN_SECONDS = 60;
const REGISTER_OTP_PURPOSE = 'register';
const LOGIN_LOCKOUT_TTL_SECONDS = 15 * 60;
const LOGIN_MAX_ATTEMPTS = 5;

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly usersService: UsersService,
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly config: ConfigService,
    private readonly mailService: MailService,
    private readonly otpService: OtpService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  async register(dto: RegisterDto): Promise<Omit<User, 'password'>> {
    const email = normalizeEmail(dto.email);
    const existingByEmail = await this.usersService.findByEmail(email);
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
      email,
      passwordHash,
      fullName: dto.fullName,
      phone: dto.phone,
    });

    // Email chào mừng dời sang lúc verify-otp thành công — lúc này tài khoản chưa xác
    // thực, "chào mừng" đúng lúc account đã thật hơn là ngay khi vừa tạo.
    await this.otpService.send(REGISTER_OTP_PURPOSE, email);

    return toSafeUser(user);
  }

  async verifyOtp(email: string, code: string): Promise<{ message: string }> {
    const normalized = normalizeEmail(email);
    const user = await this.usersService.findByEmail(normalized);
    if (!user) {
      throw new BadRequestException('Mã OTP không đúng hoặc đã hết hạn.');
    }

    const valid = await this.otpService.consume(
      REGISTER_OTP_PURPOSE,
      normalized,
      code,
    );
    if (!valid) {
      throw new BadRequestException('Mã OTP không đúng hoặc đã hết hạn.');
    }

    await this.usersService.markEmailVerified(user.id);
    await this.mailService.sendWelcomeEmail(user.email, user.fullName);

    return { message: 'Xác thực email thành công.' };
  }

  async resendOtp(email: string): Promise<{ message: string }> {
    // Không tiết lộ email có tồn tại hay không — cùng nguyên tắc với forgotPassword.
    const normalized = normalizeEmail(email);
    const user = await this.usersService.findByEmail(normalized);
    if (user) {
      await this.otpService.send(REGISTER_OTP_PURPOSE, normalized);
    }

    return { message: 'Nếu email tồn tại, mã OTP mới đã được gửi.' };
  }

  async login(
    dto: LoginDto,
  ): Promise<AuthTokens & { user: Omit<User, 'password'> }> {
    const identifier = dto.identifier.trim().toLowerCase();
    await this.assertNotLocked(identifier);

    const user = await this.usersService.findByEmailOrPhone(identifier);
    if (!user) {
      await this.recordLoginFailure(identifier);
      throw new UnauthorizedException('Email/SĐT hoặc mật khẩu không đúng');
    }

    // Không dùng message riêng ("tài khoản đã bị khóa") — tránh lộ thông tin tài khoản
    // này có tồn tại/bị khóa hay không cho người không biết mật khẩu, khớp nguyên tắc
    // chống dò tài khoản đang áp dụng cho forgot-password.
    if (user.status !== UserStatus.ACTIVE) {
      throw new UnauthorizedException('Email/SĐT hoặc mật khẩu không đúng');
    }

    const passwordMatches = await argon2.verify(user.password, dto.password);
    if (!passwordMatches) {
      await this.recordLoginFailure(identifier);
      throw new UnauthorizedException('Email/SĐT hoặc mật khẩu không đúng');
    }

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
    // Tài khoản bị khóa sau khi đã có refresh token còn hạn — chặn ở đây để lệnh khóa của
    // admin có tác dụng ngay, không phải đợi refresh token cũ (tối đa 7 ngày) hết hạn.
    if (user.status !== UserStatus.ACTIVE) {
      throw new UnauthorizedException('Tài khoản đã bị khóa hoặc vô hiệu hóa');
    }

    await this.prisma.refreshToken.update({
      where: { id: matchedTokenId },
      data: { revoked: true },
    });

    return this.issueTokens(user);
  }

  async forgotPassword(email: string): Promise<void> {
    const normalized = normalizeEmail(email);
    const user = await this.usersService.findByEmail(normalized);
    if (!user) {
      this.logger.warn(
        `Forgot-password requested for unknown email: ${normalized}`,
      );
      return;
    }

    const cooldownKey = `${RESET_COOLDOWN_PREFIX}${normalized}`;
    const acquired = await this.redis.set(
      cooldownKey,
      '1',
      'EX',
      RESET_COOLDOWN_SECONDS,
      'NX',
    );
    if (!acquired) {
      return;
    }

    const jti = randomUUID();
    const resetToken = await this.jwtService.signAsync(
      { sub: user.id, purpose: RESET_TOKEN_PURPOSE, jti },
      {
        secret: this.config.get<string>(
          RESET_TOKEN_SECRET_KEY,
          RESET_TOKEN_SECRET_DEFAULT,
        ),
        // Rút từ 15 phút xuống 10 phút — khớp yêu cầu "hiệu lực 5-10 phút" của task quên
        // mật khẩu (chọn cận trên cho đỡ gấp gáp với người dùng thật).
        expiresIn: '10m',
      },
    );
    // Ghi đè jti cũ nếu có — chỉ link mới nhất còn hiệu lực, và mỗi link chỉ dùng một lần.
    await this.redis.set(
      `${RESET_JTI_PREFIX}${user.id}`,
      jti,
      'EX',
      RESET_TOKEN_TTL_SECONDS,
    );

    const webOrigin = this.config.get<string>(
      'WEB_ORIGIN',
      'http://localhost:3000',
    );
    const resetLink = `${webOrigin}/reset-password?token=${resetToken}`;
    await this.mailService.sendPasswordResetEmail(normalized, resetLink);
  }

  async resetPassword(token: string, newPassword: string): Promise<void> {
    let payload: { sub: string; purpose: string; jti: string };
    try {
      payload = await this.jwtService.verifyAsync(token, {
        secret: this.config.get<string>(
          RESET_TOKEN_SECRET_KEY,
          RESET_TOKEN_SECRET_DEFAULT,
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

    const user = await this.usersService.findById(payload.sub);
    if (!user) {
      throw new BadRequestException(
        'Token đặt lại mật khẩu không hợp lệ hoặc đã hết hạn',
      );
    }

    // Single-use + single-outstanding: jti phải khớp giá trị mới nhất đã lưu ở Redis.
    const storedJti = await this.redis.get(`${RESET_JTI_PREFIX}${payload.sub}`);
    if (!storedJti || storedJti !== payload.jti) {
      throw new BadRequestException(
        'Token đặt lại mật khẩu không hợp lệ hoặc đã hết hạn.',
      );
    }

    if (await argon2.verify(user.password, newPassword)) {
      throw new BadRequestException(
        'Mật khẩu mới không được trùng mật khẩu cũ.',
      );
    }

    const passwordHash = await argon2.hash(newPassword);
    await this.usersService.updatePassword(user.id, passwordHash);

    await this.prisma.refreshToken.updateMany({
      where: { userId: user.id, revoked: false },
      data: { revoked: true },
    });

    // Token đã dùng xong — xóa jti để không thể dùng lại link này.
    await this.redis.del(`${RESET_JTI_PREFIX}${payload.sub}`);

    await this.mailService.sendPasswordChangedEmail(user.email);
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

function loginFailKey(identifier: string): string {
  return `login-fail:${identifier.toLowerCase()}`;
}

function asExpiresIn(value: string): `${number}${'s' | 'm' | 'h' | 'd'}` {
  return value as `${number}${'s' | 'm' | 'h' | 'd'}`;
}

function parseDurationMs(duration: string): number {
  const match = /^(\d+)([smhd])$/.exec(duration);
  if (!match) return 7 * 24 * 60 * 60 * 1000;

  const value = Number(match[1]);
  const unitMs =
    { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2]] ?? 86_400_000;
  return value * unitMs;
}
