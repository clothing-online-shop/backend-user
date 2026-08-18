// SĐT di động Việt Nam: bắt đầu bằng 0, theo sau đúng 9 chữ số (tổng 10 số) — dùng chung cho
// mọi DTO nhận SĐT (đăng ký, đổi SĐT, sổ địa chỉ...), không viết lại regex rải rác ở từng DTO.
export const VN_PHONE_REGEX = /^0\d{9}$/;

export const VN_PHONE_INVALID_MESSAGE =
  'Số điện thoại không hợp lệ (yêu cầu 10 số, bắt đầu bằng 0).';
