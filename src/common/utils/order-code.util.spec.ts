import { generateOrderCode } from './order-code.util';

describe('generateOrderCode', () => {
  it('sinh mã đúng định dạng DH + yyyyMMdd (UTC) + 6 ký tự hoa/số', () => {
    const fixedDate = new Date('2026-08-20T10:00:00.000Z');
    const code = generateOrderCode(fixedDate);
    expect(code).toMatch(/^DH20260820[A-Z0-9]{6}$/);
  });

  it('sinh 2 mã khác nhau ở 2 lần gọi liên tiếp cùng thời điểm (phần random khác nhau)', () => {
    const fixedDate = new Date('2026-08-20T10:00:00.000Z');
    const code1 = generateOrderCode(fixedDate);
    const code2 = generateOrderCode(fixedDate);
    expect(code1).not.toBe(code2);
  });
});
