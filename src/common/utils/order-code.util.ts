const CODE_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const RANDOM_PART_LENGTH = 6;

// Dùng UTC (không phải giờ local server) cho phần ngày — tránh mã đơn lệch ngày nếu server
// deploy ở timezone khác VN (Render mặc định chạy UTC).
export function generateOrderCode(now: Date = new Date()): string {
  const datePart = formatDatePart(now);
  let randomPart = '';
  for (let i = 0; i < RANDOM_PART_LENGTH; i++) {
    randomPart += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  }
  return `DH${datePart}${randomPart}`;
}

function formatDatePart(date: Date): string {
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  return `${yyyy}${mm}${dd}`;
}
