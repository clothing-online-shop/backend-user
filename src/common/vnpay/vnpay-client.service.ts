import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { buildSignedQuery } from './vnpay-signature.util';

export interface CreatePaymentUrlInput {
  orderCode: string;
  txnRef: string;
  amount: number;
  ipAddr: string;
}

// Client dựng link thanh toán VNPay — theo mẫu tổ chức của GhnClient (config qua
// ConfigService, không hardcode). Khác GhnClient (gọi API GHN qua HTTP), VNPay "gọi" bằng
// cách redirect trình duyệt khách tới 1 URL đã ký sẵn, không có response HTTP để đọc ở đây.
@Injectable()
export class VnpayClient {
  private readonly tmnCode: string;
  private readonly hashSecret: string;
  private readonly payUrl: string;
  private readonly returnUrl: string;

  constructor(private readonly config: ConfigService) {
    this.tmnCode = this.config.get<string>('VNPAY_TMN_CODE', '');
    this.hashSecret = this.config.get<string>('VNPAY_HASH_SECRET', '');
    this.payUrl = this.config.get<string>(
      'VNPAY_PAY_URL',
      'https://sandbox.vnpayment.vn/paymentv2/vpcpay.html',
    );
    this.returnUrl = this.config.get<string>(
      'VNPAY_RETURN_URL',
      'http://localhost:3000/payment/return',
    );
  }

  buildPaymentUrl(input: CreatePaymentUrlInput): string {
    const params: Record<string, string> = {
      vnp_Version: '2.1.0',
      vnp_Command: 'pay',
      vnp_TmnCode: this.tmnCode,
      vnp_Amount: String(Math.round(input.amount * 100)),
      vnp_CurrCode: 'VND',
      vnp_TxnRef: input.txnRef,
      vnp_OrderInfo: `Thanh toan don hang ${input.orderCode}`,
      vnp_OrderType: 'other',
      vnp_Locale: 'vn',
      vnp_ReturnUrl: this.returnUrl,
      vnp_IpAddr: input.ipAddr,
      vnp_CreateDate: formatVnpayDate(new Date()),
    };

    return `${this.payUrl}?${buildSignedQuery(params, this.hashSecret)}`;
  }

  getHashSecret(): string {
    return this.hashSecret;
  }
}

// VNPay yêu cầu đúng format yyyyMMddHHmmss theo giờ Việt Nam (GMT+7) — không dùng
// toISOString() (UTC + có dấu "-"/"T"/"Z" không đúng format VNPay yêu cầu).
function formatVnpayDate(date: Date): string {
  const vietnamTime = new Date(date.getTime() + 7 * 60 * 60 * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${vietnamTime.getUTCFullYear()}${pad(vietnamTime.getUTCMonth() + 1)}${pad(vietnamTime.getUTCDate())}` +
    `${pad(vietnamTime.getUTCHours())}${pad(vietnamTime.getUTCMinutes())}${pad(vietnamTime.getUTCSeconds())}`
  );
}
