import * as argon2 from 'argon2';
import { AuthService } from './auth.service';

// argon2's native addon exports are non-configurable, so jest.spyOn cannot patch
// them directly. Re-wrap the module in a plain object that keeps the real
// implementations but allows individual functions to be spied on per-test.
jest.mock('argon2', () => ({
  __esModule: true,
  ...jest.requireActual<typeof import('argon2')>('argon2'),
}));

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

describe('AuthService reset token jti', () => {
  afterEach(() => jest.restoreAllMocks());

  const validPayload = { sub: 'u1', purpose: 'reset-password', jti: 'jti-123' };

  function primeResetOk(h: ReturnType<typeof createHarness>) {
    (h.jwtService.verifyAsync as jest.Mock).mockResolvedValue(validPayload);
    (h.usersService.findById as jest.Mock).mockResolvedValue({
      id: 'u1',
      password: 'hash-of-something-else',
      email: 'u@b.com',
    });
    // argon2.verify against a bogus hash throws -> treat as "not the same password"
    jest.spyOn(argon2, 'verify').mockResolvedValue(false);
  }

  it('stores a jti when issuing the reset link', async () => {
    const h = createHarness();
    (h.usersService.findByEmail as jest.Mock).mockResolvedValue({
      id: 'u1',
      email: 'u@b.com',
    });

    await h.service.forgotPassword('u@b.com');

    const setCall = (h.redis.set as jest.Mock).mock.calls.find(([k]) =>
      String(k).startsWith('pwd-reset-jti:u1'),
    ) as unknown[] | undefined;
    expect(setCall).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const signedJti = (h.jwtService.signAsync as jest.Mock).mock.calls.find(
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      ([p]) => p?.purpose === 'reset-password',
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    )[0].jti;
    expect(setCall![1]).toBe(signedJti);
  });

  it('rejects when the stored jti does not match', async () => {
    const h = createHarness();
    primeResetOk(h);
    (h.redis.get as jest.Mock).mockResolvedValue('a-different-jti');

    await expect(
      h.service.resetPassword('token', 'newpassword1'),
    ).rejects.toThrow('Token đặt lại mật khẩu không hợp lệ hoặc đã hết hạn.');
  });

  it('rejects when there is no stored jti (already used / expired)', async () => {
    const h = createHarness();
    primeResetOk(h);
    (h.redis.get as jest.Mock).mockResolvedValue(null);

    await expect(
      h.service.resetPassword('token', 'newpassword1'),
    ).rejects.toThrow();
  });

  it('deletes the jti after a successful reset', async () => {
    const h = createHarness();
    primeResetOk(h);
    (h.redis.get as jest.Mock).mockResolvedValue('jti-123');
    (h.usersService.updatePassword as jest.Mock).mockResolvedValue({});

    await h.service.resetPassword('token', 'newpassword1');

    const redis = h.redis as unknown as Record<string, jest.Mock>;
    expect(redis.del).toHaveBeenCalledWith('pwd-reset-jti:u1');
  });
});

describe('AuthService.forgotPassword cooldown', () => {
  it('does not send a second email while the cooldown is active', async () => {
    const h = createHarness();
    (h.usersService.findByEmail as jest.Mock).mockResolvedValue({
      id: 'u1',
      email: 'u@b.com',
    });
    (h.redis.exists as jest.Mock).mockResolvedValue(1);

    await h.service.forgotPassword('u@b.com');

    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(h.mailService.sendPasswordResetEmail).not.toHaveBeenCalled();
  });

  it('sends and sets the cooldown key when not on cooldown', async () => {
    const h = createHarness();
    (h.usersService.findByEmail as jest.Mock).mockResolvedValue({
      id: 'u1',
      email: 'u@b.com',
    });
    (h.redis.exists as jest.Mock).mockResolvedValue(0);

    await h.service.forgotPassword('u@b.com');

    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(h.mailService.sendPasswordResetEmail).toHaveBeenCalled();
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const setCall = (h.redis.set as jest.Mock).mock.calls.find(([k]) =>
      String(k).startsWith('pwd-reset-cooldown:u@b.com'),
    );
    expect(setCall).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
    expect(setCall?.slice(-2)).toEqual(['EX', 60]);
  });
});
