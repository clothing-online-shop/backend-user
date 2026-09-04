// Chuẩn hóa email trước khi query/lưu — email phân biệt hoa thường ở cột unique của Postgres,
// không chuẩn hóa sẽ tạo được 2 tài khoản "trùng" (Test@x.com vs test@x.com).
export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

// Che bớt email khi hiển thị trong mail cảnh báo bảo mật (không lộ đầy đủ địa chỉ mới cho
// người đọc mail ở địa chỉ cũ).
export function maskEmail(email: string): string {
  const atIndex = email.indexOf('@');
  if (atIndex === -1) return email;

  const local = email.slice(0, atIndex);
  const domain = email.slice(atIndex);

  if (local.length <= 2) {
    return `${'*'.repeat(local.length)}${domain}`;
  }
  return `${local[0]}${'*'.repeat(local.length - 2)}${local[local.length - 1]}${domain}`;
}
