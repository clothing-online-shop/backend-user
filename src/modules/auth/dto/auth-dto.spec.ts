import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { RegisterDto } from './register.dto';
import { ResetPasswordDto } from './reset-password.dto';

function errorsFor<T extends object>(
  cls: new () => T,
  payload: Record<string, unknown>,
) {
  const dto = plainToInstance(cls, payload);
  return validateSync(dto as object).flatMap((e) =>
    Object.keys(e.constraints ?? {}),
  );
}

describe('RegisterDto', () => {
  const base = {
    email: 'a@b.com',
    password: 'password1',
    fullName: 'Nguyen Van A',
  };

  it('rejects a password shorter than 8', () => {
    expect(errorsFor(RegisterDto, { ...base, password: 'short7!' })).toContain(
      'minLength',
    );
  });

  it('accepts an 8-char password', () => {
    expect(errorsFor(RegisterDto, base)).toHaveLength(0);
  });

  it('rejects a malformed phone', () => {
    expect(errorsFor(RegisterDto, { ...base, phone: '12345' })).toContain(
      'matches',
    );
  });

  it('accepts a valid VN phone', () => {
    expect(
      errorsFor(RegisterDto, { ...base, phone: '0901234567' }),
    ).toHaveLength(0);
  });

  it('still allows an omitted phone', () => {
    expect(errorsFor(RegisterDto, base)).toHaveLength(0);
  });
});

describe('ResetPasswordDto', () => {
  it('rejects a newPassword shorter than 8', () => {
    expect(
      errorsFor(ResetPasswordDto, { token: 't', newPassword: 'short7!' }),
    ).toContain('minLength');
  });
});
