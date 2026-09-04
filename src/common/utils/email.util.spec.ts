import { normalizeEmail, maskEmail } from './email.util';

describe('normalizeEmail', () => {
  it('trims and lowercases', () => {
    expect(normalizeEmail('  John.Doe@Example.COM ')).toBe(
      'john.doe@example.com',
    );
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
