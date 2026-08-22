// Template email cơ bản dạng HTML inline — đủ dùng cho sprint đầu, có thể thay
// bằng engine template (Handlebars/MJML) sau nếu cần thiết kế phức tạp hơn.
import type { OrderStatus } from '@prisma/client';

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

export interface OrderConfirmationEmailItem {
  productName: string;
  size: string;
  color: string;
  quantity: number;
  priceAtPurchase: number;
}

export interface OrderConfirmationEmailData {
  orderCode: string;
  totalAmount: number;
  shippingAddress: string;
  paymentMethod: string;
  items: OrderConfirmationEmailItem[];
}

// Khớp các giá trị enum PaymentProvider trong schema.prisma (backend-cms) — giá trị lạ
// (không map được) rơi về chính chuỗi gốc thay vì lỗi, để không chặn gửi email.
const PAYMENT_METHOD_LABEL: Record<string, string> = {
  COD: 'Thanh toán khi nhận hàng (COD)',
  VNPAY: 'Chuyển khoản qua VNPay',
  MOMO: 'Ví MoMo',
  STRIPE: 'Thẻ quốc tế (Stripe)',
};

function paymentMethodLabel(paymentMethod: string): string {
  return PAYMENT_METHOD_LABEL[paymentMethod] ?? paymentMethod;
}

export function orderConfirmationEmailTemplate(
  order: OrderConfirmationEmailData,
): { subject: string; html: string } {
  const itemsHtml = order.items
    .map(
      (item) => `
        <tr>
          <td style="padding: 8px 0; border-bottom: 1px solid #eee;">
            ${item.productName} (${item.size} / ${item.color})
          </td>
          <td style="padding: 8px 0; border-bottom: 1px solid #eee; text-align: center;">
            x${item.quantity}
          </td>
          <td style="padding: 8px 0; border-bottom: 1px solid #eee; text-align: right;">
            ${item.priceAtPurchase.toLocaleString('vi-VN')}đ
          </td>
        </tr>`,
    )
    .join('');

  return {
    subject: `Xác nhận đơn hàng #${order.orderCode}`,
    html: layout(
      'Đặt hàng thành công',
      `<p>Cảm ơn bạn đã đặt hàng tại Clothing Shop.</p>
       <p>Mã đơn hàng: <strong>${order.orderCode}</strong></p>
       <table style="width: 100%; border-collapse: collapse; margin: 16px 0;">
         ${itemsHtml}
       </table>
       <p>Địa chỉ giao hàng: <strong>${order.shippingAddress}</strong></p>
       <p>Phương thức thanh toán: <strong>${paymentMethodLabel(order.paymentMethod)}</strong></p>
       <p>Tổng tiền: <strong>${order.totalAmount.toLocaleString('vi-VN')}đ</strong></p>
       <p>Chúng tôi sẽ xử lý đơn hàng của bạn trong thời gian sớm nhất.</p>`,
    ),
  };
}

// Khớp enum OrderStatus (schema.prisma, backend-cms) — dùng khi backend-cms gọi
// POST /internal/orders/:orderCode/status-notification mỗi lần admin đổi trạng thái đơn.
const ORDER_STATUS_LABEL: Record<OrderStatus, string> = {
  PENDING: 'Chờ xác nhận',
  CONFIRMED: 'Đã xác nhận',
  PACKING: 'Đang đóng gói',
  HANDED_OVER: 'Đã bàn giao vận chuyển',
  SHIPPING: 'Đang giao',
  COMPLETED: 'Hoàn tất',
  CANCELLED: 'Đã hủy',
};

export interface OrderStatusUpdateEmailData {
  orderCode: string;
  customerName: string;
  status: OrderStatus;
  note?: string | null;
}

export function orderStatusUpdateEmailTemplate(
  data: OrderStatusUpdateEmailData,
): { subject: string; html: string } {
  const statusLabel = ORDER_STATUS_LABEL[data.status];
  return {
    subject: `Cập nhật đơn hàng #${data.orderCode}: ${statusLabel}`,
    html: layout(
      'Cập nhật đơn hàng',
      `<p>Xin chào <strong>${data.customerName}</strong>,</p>
       <p>Đơn hàng <strong>#${data.orderCode}</strong> của bạn vừa được cập nhật trạng thái:</p>
       <p style="font-size: 18px; font-weight: bold;">${statusLabel}</p>
       ${data.note ? `<p>Lý do: ${data.note}</p>` : ''}`,
    ),
  };
}
