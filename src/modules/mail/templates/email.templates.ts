// Template email cơ bản dạng HTML inline — đủ dùng cho sprint đầu, có thể thay
// bằng engine template (Handlebars/MJML) sau nếu cần thiết kế phức tạp hơn.

function layout(title: string, bodyHtml: string): string {
  return `
    <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px; color: #1a1a1a;">
      <h2 style="margin-bottom: 16px;">${title}</h2>
      ${bodyHtml}
      <p style="margin-top: 32px; font-size: 12px; color: #888;">
        Đây là email tự động từ Clothing Shop, vui lòng không phản hồi email này.
      </p>
    </div>
  `;
}

export function welcomeEmailTemplate(fullName: string): {
  subject: string;
  html: string;
} {
  return {
    subject: 'Chào mừng bạn đến với Clothing Shop',
    html: layout(
      'Chào mừng!',
      `<p>Xin chào <strong>${fullName}</strong>,</p>
       <p>Cảm ơn bạn đã đăng ký tài khoản tại Clothing Shop. Chúc bạn mua sắm vui vẻ!</p>`,
    ),
  };
}

export function otpEmailTemplate(otp: string): {
  subject: string;
  html: string;
} {
  return {
    subject: 'Mã xác thực OTP của bạn',
    html: layout(
      'Mã xác thực OTP',
      `<p>Mã OTP của bạn là:</p>
       <p style="font-size: 28px; font-weight: bold; letter-spacing: 4px;">${otp}</p>
       <p>Mã có hiệu lực trong 5 phút. Không chia sẻ mã này cho bất kỳ ai.</p>`,
    ),
  };
}

export function passwordResetEmailTemplate(resetLink: string): {
  subject: string;
  html: string;
} {
  return {
    subject: 'Đặt lại mật khẩu Clothing Shop',
    html: layout(
      'Đặt lại mật khẩu',
      `<p>Bạn (hoặc ai đó) vừa yêu cầu đặt lại mật khẩu cho tài khoản này.</p>
       <p><a href="${resetLink}" style="display: inline-block; padding: 10px 20px; background: #111; color: #fff; text-decoration: none; border-radius: 4px;">Đặt lại mật khẩu</a></p>
       <p>Link có hiệu lực trong 15 phút. Nếu bạn không yêu cầu, hãy bỏ qua email này.</p>`,
    ),
  };
}

export function orderConfirmationEmailTemplate(order: {
  orderCode: string;
  totalAmount: number;
}): { subject: string; html: string } {
  return {
    subject: `Xác nhận đơn hàng #${order.orderCode}`,
    html: layout(
      'Đặt hàng thành công',
      `<p>Cảm ơn bạn đã đặt hàng tại Clothing Shop.</p>
       <p>Mã đơn hàng: <strong>${order.orderCode}</strong></p>
       <p>Tổng tiền: <strong>${order.totalAmount.toLocaleString('vi-VN')}đ</strong></p>
       <p>Chúng tôi sẽ xử lý đơn hàng của bạn trong thời gian sớm nhất.</p>`,
    ),
  };
}
