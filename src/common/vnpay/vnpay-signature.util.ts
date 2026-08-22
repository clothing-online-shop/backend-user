import { createHmac, timingSafeEqual } from 'crypto';

// Đúng thuật toán ký/xác thực chính thức của VNPay: sort key theo alphabet, encode value
// bằng encodeURIComponent rồi đổi "%20" thành "+" (khác encode chuẩn URL — đây là quy ước
// riêng của VNPay, phải giữ đúng để chữ ký khớp với phía VNPay tính). Không filter giá trị
// rỗng — VNPay tự sort/encode nguyên object nhận được, filter thêm sẽ làm lệch signData so
// với cách VNPay tính ở phía họ.
function sortedEncodedEntries(
  params: Record<string, string | undefined>,
): [string, string][] {
  return Object.keys(params)
    .filter((key) => params[key] !== undefined && params[key] !== null)
    .sort()
    .map((key) => [
      key,
      encodeURIComponent(params[key] as string).replace(/%20/g, '+'),
    ]);
}

function toSignData(entries: [string, string][]): string {
  return entries.map(([key, value]) => `${key}=${value}`).join('&');
}

function hmacSha512(data: string, hashSecret: string): string {
  return createHmac('sha512', hashSecret)
    .update(Buffer.from(data, 'utf-8'))
    .digest('hex');
}

// So sánh 2 chuỗi hex chữ ký bằng timing-safe compare — tránh lộ thông tin qua thời gian
// phản hồi (timing attack) khi so sánh chữ ký byte-by-byte thông thường.
function timingSafeEqualHex(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'hex');
  const bufB = Buffer.from(b, 'hex');
  if (bufA.length !== bufB.length || bufA.length === 0) return false;
  return timingSafeEqual(bufA, bufB);
}

// Dùng khi TẠO request gửi VNPay (tạo giao dịch) — trả nguyên querystring đã ký kèm
// vnp_SecureHash, ghép thẳng sau payUrl là ra link thanh toán.
export function buildSignedQuery(
  params: Record<string, string>,
  hashSecret: string,
): string {
  const entries = sortedEncodedEntries(params);
  const secureHash = hmacSha512(toSignData(entries), hashSecret);
  return `${toSignData(entries)}&vnp_SecureHash=${secureHash}`;
}

// Dùng khi NHẬN phản hồi từ VNPay (Return URL / IPN) — tách vnp_SecureHash ra khỏi params
// trước khi tính lại, đúng cách VNPay verify ở phía họ.
export function verifySignature(
  params: Record<string, string | undefined>,
  hashSecret: string,
): boolean {
  const vnp_SecureHash = params.vnp_SecureHash;
  if (!vnp_SecureHash) return false;

  const rest: Record<string, string | undefined> = {};
  for (const key of Object.keys(params)) {
    if (key === 'vnp_SecureHash' || key === 'vnp_SecureHashType') continue;
    rest[key] = params[key];
  }

  const entries = sortedEncodedEntries(rest);
  const expected = hmacSha512(toSignData(entries), hashSecret);
  return timingSafeEqualHex(expected, vnp_SecureHash);
}
