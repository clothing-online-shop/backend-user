import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, User, UserRole } from '@prisma/client';
import * as argon2 from 'argon2';
import { PrismaService } from '../../config/prisma.service';
import { OtpService } from '../../common/otp/otp.service';
import { MailService } from '../mail/mail.service';
import { toSafeUser } from '../../common/utils/safe-user.util';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { ChangePasswordDto } from './dto/change-password.dto';

export interface CreateUserInput {
  email: string;
  passwordHash: string;
  fullName: string;
  phone?: string;
  role?: UserRole;
}

const EMAIL_CHANGE_OTP_PURPOSE = 'change-email';
const PHONE_CHANGE_OTP_PURPOSE = 'change-phone';

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly otpService: OtpService,
    private readonly mailService: MailService,
  ) {}

  findByEmail(email: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { email } });
  }

  findByPhone(phone: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { phone } });
  }

  // Đăng nhập chấp nhận cả email lẫn SĐT — thử email trước (định dạng rõ ràng hơn để
  // phân biệt), không thấy mới thử theo SĐT.
  async findByEmailOrPhone(identifier: string): Promise<User | null> {
    return (
      (await this.findByEmail(identifier)) ??
      (await this.findByPhone(identifier))
    );
  }

  findById(id: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { id } });
  }

  create(input: CreateUserInput): Promise<User> {
    return this.prisma.user.create({
      data: {
        email: input.email,
        password: input.passwordHash,
        fullName: input.fullName,
        phone: input.phone,
        role: input.role ?? UserRole.CUSTOMER,
      },
    });
  }

  updatePassword(userId: string, passwordHash: string): Promise<User> {
    return this.prisma.user.update({
      where: { id: userId },
      data: { password: passwordHash },
    });
  }

  markEmailVerified(userId: string): Promise<User> {
    return this.prisma.user.update({
      where: { id: userId },
      data: { emailVerifiedAt: new Date() },
    });
  }

  async getProfile(userId: string) {
    const user = await this.findExisting(userId);
    return this.toProfileResponse(user);
  }

  async updateProfile(userId: string, dto: UpdateProfileDto) {
    await this.findExisting(userId);
    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: {
        fullName: dto.fullName,
        dateOfBirth: dto.dateOfBirth ? new Date(dto.dateOfBirth) : undefined,
        gender: dto.gender,
        avatarUrl: dto.avatarUrl,
        avatarPublicId: dto.avatarPublicId,
      },
    });
    return this.toProfileResponse(updated);
  }

  async changePassword(
    userId: string,
    dto: ChangePasswordDto,
  ): Promise<{ message: string }> {
    const user = await this.findExisting(userId);
    await this.verifyCurrentPassword(user, dto.currentPassword);

    if (dto.newPassword === dto.currentPassword) {
      throw new BadRequestException(
        'Mật khẩu mới không được trùng mật khẩu hiện tại.',
      );
    }

    const passwordHash = await argon2.hash(dto.newPassword);
    await this.updatePassword(userId, passwordHash);

    // Đổi mật khẩu xong thu hồi mọi refresh token đang hoạt động — khớp cách
    // AuthService.resetPassword() xử lý, buộc đăng nhập lại ở mọi thiết bị khác.
    await this.prisma.refreshToken.updateMany({
      where: { userId, revoked: false },
      data: { revoked: true },
    });

    return { message: 'Đổi mật khẩu thành công.' };
  }

  async requestEmailChange(
    userId: string,
    newEmail: string,
    currentPassword: string,
  ): Promise<{ message: string }> {
    const user = await this.findExisting(userId);
    await this.verifyCurrentPassword(user, currentPassword);

    const normalizedEmail = newEmail.trim().toLowerCase();
    if (normalizedEmail === user.email.toLowerCase()) {
      throw new BadRequestException('Email mới trùng với email hiện tại.');
    }
    if (await this.findByEmail(normalizedEmail)) {
      throw new ConflictException('Email đã được sử dụng.');
    }

    await this.otpService.send(EMAIL_CHANGE_OTP_PURPOSE, normalizedEmail);
    return { message: 'Mã OTP đã được gửi tới email mới.' };
  }

  async confirmEmailChange(userId: string, newEmail: string, code: string) {
    await this.findExisting(userId);
    const normalizedEmail = newEmail.trim().toLowerCase();

    const valid = await this.otpService.consume(
      EMAIL_CHANGE_OTP_PURPOSE,
      normalizedEmail,
      code,
    );
    if (!valid) {
      throw new BadRequestException('Mã OTP không đúng hoặc đã hết hạn.');
    }

    try {
      const updated = await this.prisma.user.update({
        where: { id: userId },
        data: { email: normalizedEmail, emailVerifiedAt: new Date() },
      });
      return this.toProfileResponse(updated);
    } catch (err) {
      throw this.asConflictIfDuplicate(err, 'Email đã được sử dụng.');
    }
  }

  async requestPhoneChange(
    userId: string,
    newPhone: string,
    currentPassword: string,
  ): Promise<{ message: string }> {
    const user = await this.findExisting(userId);
    await this.verifyCurrentPassword(user, currentPassword);

    if (newPhone === user.phone) {
      throw new BadRequestException('Số điện thoại mới trùng với số hiện tại.');
    }
    if (await this.findByPhone(newPhone)) {
      throw new ConflictException('Số điện thoại đã được sử dụng.');
    }

    // Chưa có hạ tầng gửi SMS — xác thực đổi SĐT qua OTP gửi tới EMAIL hiện tại (đã xác
    // thực), không gửi thẳng tới SĐT mới.
    await this.otpService.send(PHONE_CHANGE_OTP_PURPOSE, user.email);
    return { message: 'Mã OTP đã được gửi tới email hiện tại của bạn.' };
  }

  async confirmPhoneChange(userId: string, newPhone: string, code: string) {
    const user = await this.findExisting(userId);

    const valid = await this.otpService.consume(
      PHONE_CHANGE_OTP_PURPOSE,
      user.email,
      code,
    );
    if (!valid) {
      throw new BadRequestException('Mã OTP không đúng hoặc đã hết hạn.');
    }

    try {
      const updated = await this.prisma.user.update({
        where: { id: userId },
        data: { phone: newPhone, phoneVerifiedAt: new Date() },
      });
      return this.toProfileResponse(updated);
    } catch (err) {
      throw this.asConflictIfDuplicate(err, 'Số điện thoại đã được sử dụng.');
    }
  }

  private async verifyCurrentPassword(
    user: User,
    currentPassword: string,
  ): Promise<void> {
    const matches = await argon2.verify(user.password, currentPassword);
    if (!matches) {
      throw new BadRequestException('Mật khẩu hiện tại không đúng.');
    }
  }

  private async findExisting(userId: string): Promise<User> {
    const user = await this.findById(userId);
    if (!user) {
      throw new NotFoundException('Không tìm thấy người dùng.');
    }
    return user;
  }

  // request*Change() đã pre-check trùng, nhưng vẫn có thể thua 1 request khác đăng ký/đổi
  // đúng giá trị đó ngay trong khoảng chờ OTP — bắt P2002 ở lần ghi thật để trả lỗi rõ
  // ràng thay vì để lộ 500 thô.
  private asConflictIfDuplicate(err: unknown, message: string): Error {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === 'P2002'
    ) {
      return new ConflictException(message);
    }
    return err as Error;
  }

  private toProfileResponse(user: User) {
    return {
      ...toSafeUser(user),
      phone: user.phone ? maskPhone(user.phone) : null,
    };
  }
}

// Ẩn 1 phần SĐT khi trả về hồ sơ — giữ 3 số đầu + 3 số cuối, che phần giữa (vd
// "0901234567" -> "090****567"). SĐT ngắn bất thường (<=6 ký tự) trả nguyên, không có gì
// để che mà không mất hết thông tin.
function maskPhone(phone: string): string {
  if (phone.length <= 6) return phone;
  const visibleStart = phone.slice(0, 3);
  const visibleEnd = phone.slice(-3);
  return `${visibleStart}${'*'.repeat(phone.length - 6)}${visibleEnd}`;
}
