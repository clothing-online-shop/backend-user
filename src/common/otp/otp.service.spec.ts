import { BadRequestException } from '@nestjs/common';
import type Redis from 'ioredis';
import { OtpService } from './otp.service';
import { MailService } from '../../modules/mail/mail.service';

function createHarness() {
  const store = new Map<string, string>();
  const redis = {
    exists: jest.fn((k: string): number => (store.has(k) ? 1 : 0)),
    set: jest.fn((k: string, v: string): string => {
      store.set(k, v);
      return 'OK';
    }),
    get: jest.fn((k: string): string | null => store.get(k) ?? null),
    del: jest.fn((k: string): number => {
      store.delete(k);
      return 1;
    }),
  };
  const sendOtpEmail = jest.fn<Promise<void>, [email: string, code: string]>();

  const service = new OtpService(
    redis as unknown as Redis,
    { sendOtpEmail } as unknown as MailService,
  );
  return { service, redis, sendOtpEmail, store };
}

describe('OtpService.send', () => {
  it('emails a 6-digit numeric code', async () => {
    const h = createHarness();
    await h.service.send('register', 'a@b.com');
    const code = h.sendOtpEmail.mock.calls[0][1];
    expect(code).toMatch(/^\d{6}$/);
  });

  it('does not use Math.random for code generation', async () => {
    const spy = jest.spyOn(Math, 'random');
    const h = createHarness();
    await h.service.send('register', 'a@b.com');
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('rejects when the resend cooldown key exists', async () => {
    const h = createHarness();
    await h.service.send('register', 'a@b.com');
    await expect(h.service.send('register', 'a@b.com')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});

describe('OtpService.consume', () => {
  it('accepts the right code once and deletes it', async () => {
    const h = createHarness();
    await h.service.send('register', 'a@b.com');
    const code = h.sendOtpEmail.mock.calls[0][1];
    expect(await h.service.consume('register', 'a@b.com', code)).toBe(true);
    expect(await h.service.consume('register', 'a@b.com', code)).toBe(false);
  });

  it('drops the code after 5 wrong attempts', async () => {
    const h = createHarness();
    await h.service.send('register', 'a@b.com');
    const code = h.sendOtpEmail.mock.calls[0][1];
    for (let i = 0; i < 5; i++) {
      expect(await h.service.consume('register', 'a@b.com', '000000')).toBe(
        false,
      );
    }
    expect(await h.service.consume('register', 'a@b.com', code)).toBe(false);
  });

  it('returns false when there is no stored code', async () => {
    const h = createHarness();
    expect(await h.service.consume('register', 'nobody@b.com', '123456')).toBe(
      false,
    );
  });
});
