import { timingSafeEqual } from 'crypto';

// So sánh 2 chuỗi bằng timing-safe compare — so sánh `!==`/`===` byte-by-byte thông thường
// có thể lộ thông tin về secret/chữ ký qua thời gian phản hồi (timing attack). Dùng chung cho
// chữ ký VNPay dạng hex (xem vnpay-signature.util.ts, encoding='hex') và secret dạng chuỗi
// bất kỳ như INTERNAL_NOTIFY_KEY (xem internal-api-key.guard.ts, encoding mặc định 'utf8').
export function timingSafeEqualString(
  a: string,
  b: string,
  encoding: BufferEncoding = 'utf8',
): boolean {
  const bufA = Buffer.from(a, encoding);
  const bufB = Buffer.from(b, encoding);
  if (bufA.length !== bufB.length || bufA.length === 0) return false;
  return timingSafeEqual(bufA, bufB);
}
