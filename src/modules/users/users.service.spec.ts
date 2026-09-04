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
  const otpService = {
    send: jest.fn(),
    consume: jest.fn(),
  } as unknown as OtpService;
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
    (h.prisma.user.findUnique as jest.Mock).mockResolvedValue({
      id: 'u1',
      password: hash,
      email: 'u@b.com',
    });

    await expect(
      h.service.changePassword('u1', {
        currentPassword: 'password1',
        newPassword: 'password1',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('UsersService change-password notification', () => {
  it('sends a password-changed email after a successful change', async () => {
    const h = createHarness();
    const hash = await argon2.hash('password1');
    (h.prisma.user.findUnique as jest.Mock).mockResolvedValue({
      id: 'u1',
      password: hash,
      email: 'u@b.com',
    });
    (h.prisma.user.update as jest.Mock).mockResolvedValue({});
    (h.prisma.refreshToken.updateMany as jest.Mock).mockResolvedValue({});

    await h.service.changePassword('u1', {
      currentPassword: 'password1',
      newPassword: 'password2',
    });

    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(h.mailService.sendPasswordChangedEmail).toHaveBeenCalledWith(
      'u@b.com',
    );
  });

  it('still succeeds if the notification email throws', async () => {
    const h = createHarness();
    const hash = await argon2.hash('password1');
    (h.prisma.user.findUnique as jest.Mock).mockResolvedValue({
      id: 'u1',
      password: hash,
      email: 'u@b.com',
    });
    (h.prisma.user.update as jest.Mock).mockResolvedValue({});
    (h.prisma.refreshToken.updateMany as jest.Mock).mockResolvedValue({});
    (h.mailService.sendPasswordChangedEmail as jest.Mock).mockRejectedValue(
      new Error('smtp down'),
    );

    await expect(
      h.service.changePassword('u1', {
        currentPassword: 'password1',
        newPassword: 'password2',
      }),
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    ).resolves.toMatchObject({ message: expect.any(String) });
  });
});
