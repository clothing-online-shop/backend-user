import * as argon2 from 'argon2';
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

  return {
    service,
    usersService,
    prisma,
    jwtService,
    config,
    mailService,
    otpService,
    redis,
  };
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
    });

    const users = h.usersService as unknown as Record<string, jest.Mock>;
    const otp = h.otpService as unknown as Record<string, jest.Mock>;
    expect(users.findByEmail).toHaveBeenCalledWith('user@example.com');
    const createArg = (users.create.mock.calls[0] as unknown[])[0] as {
      email: string;
    };
    expect(createArg.email).toBe('user@example.com');
    expect(otp.send).toHaveBeenCalledWith('register', 'user@example.com');
  });

  it('login queries with the normalized identifier', async () => {
    const h = createHarness();
    (h.usersService.findByEmailOrPhone as jest.Mock).mockResolvedValue(null);

    await expect(
      h.service.login({
        identifier: '  User@Example.COM ',
        password: 'password1',
      }),
    ).rejects.toThrow();

    const users = h.usersService as unknown as Record<string, jest.Mock>;
    expect(users.findByEmailOrPhone).toHaveBeenCalledWith('user@example.com');
  });
});

describe('AuthService.resetPassword password reuse', () => {
  it('rejects a new password identical to the stored one', async () => {
    const h = createHarness();
    const hash = await argon2.hash('oldpassword');
    (h.jwtService.verifyAsync as jest.Mock).mockResolvedValue({
      sub: 'u1',
      purpose: 'reset-password',
      jti: 'j1',
    });
    (h.usersService.findById as jest.Mock).mockResolvedValue({
      id: 'u1',
      password: hash,
      email: 'u@b.com',
    });
    (h.redis.get as jest.Mock).mockResolvedValue('j1'); // jti check added in Task 7; harmless here

    await expect(
      h.service.resetPassword('token', 'oldpassword'),
    ).rejects.toThrow('Mật khẩu mới không được trùng mật khẩu cũ.');
  });
});

describe('AuthService reset token secret', () => {
  it('signs forgot-password token with JWT_RESET_SECRET', async () => {
    const h = createHarness();
    (h.usersService.findByEmail as jest.Mock).mockResolvedValue({
      id: 'u1',
      email: 'u@b.com',
    });

    await h.service.forgotPassword('u@b.com');

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const signCall = (h.jwtService.signAsync as jest.Mock).mock.calls.find(
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      ([payload]) => payload?.purpose === 'reset-password',
    );
    expect(signCall).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(signCall[1].secret).toBe('change-me-reset-secret');
  });

  it('verifies reset token with JWT_RESET_SECRET', async () => {
    const h = createHarness();
    (h.jwtService.verifyAsync as jest.Mock).mockRejectedValue(
      new Error('bad sig'),
    );

    await expect(
      h.service.resetPassword('token', 'newpassword1'),
    ).rejects.toThrow();
    expect(
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      (h.jwtService.verifyAsync as jest.Mock).mock.calls[0][1].secret,
    ).toBe('change-me-reset-secret');
  });
});
