import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  Order,
  PaymentStatus,
  PaymentProvider,
  Prisma,
  TransactionStatus,
} from '@prisma/client';
import { PrismaService } from '../../config/prisma.service';
import { VnpayClient } from '../../common/vnpay/vnpay-client.service';
import { verifySignature } from '../../common/vnpay/vnpay-signature.util';
import { OrdersService } from '../orders/orders.service';
import { CheckoutPaymentMethod } from '../orders/dto/create-order.dto';

export interface VnpayReturnResult {
  success: boolean;
  orderId: string | null;
  orderCode: string;
  message: string;
}

export interface VnpayIpnAck {
  RspCode: string;
  Message: string;
}

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly vnpayClient: VnpayClient,
    private readonly ordersService: OrdersService,
  ) {}

  // Gọi lại được nhiều lần cho cùng 1 đơn (thanh toán lại — task 2, hoặc đổi từ chuyển
  // khoản sang VNPay) — mỗi lần tạo 1 PaymentTransaction PENDING mới, không xóa lịch sử cũ.
  async initiateVnpay(
    userId: string,
    orderId: string,
    ipAddr: string,
  ): Promise<{ paymentUrl: string }> {
    const order = await this.ordersService.findOwnedOrder(userId, orderId);
    this.assertNotYetPaid(order);

    const txnRef = `${order.orderCode}-${Date.now().toString(36)}`;
    await this.prisma.paymentTransaction.create({
      data: {
        orderId: order.id,
        provider: PaymentProvider.VNPAY,
        amount: order.totalAmount,
        status: TransactionStatus.PENDING,
        rawPayload: { txnRef },
      },
    });

    const paymentUrl = this.vnpayClient.buildPaymentUrl({
      orderCode: order.orderCode,
      txnRef,
      amount: order.totalAmount,
      ipAddr,
    });
    return { paymentUrl };
  }

  async initiateBankTransfer(
    userId: string,
    orderId: string,
  ): Promise<{
    bankAccountNumber: string;
    bankAccountName: string;
    bankName: string;
    transferContent: string;
    amount: number;
  }> {
    const order = await this.ordersService.findOwnedOrder(userId, orderId);
    this.assertNotYetPaid(order);

    await this.prisma.$transaction([
      this.prisma.order.update({
        where: { id: order.id },
        data: { paymentMethod: CheckoutPaymentMethod.BANK_TRANSFER },
      }),
      this.prisma.paymentTransaction.create({
        data: {
          orderId: order.id,
          provider: PaymentProvider.BANK_TRANSFER,
          amount: order.totalAmount,
          status: TransactionStatus.PENDING,
        },
      }),
    ]);

    return {
      bankAccountNumber: this.config.get<string>('BANK_ACCOUNT_NUMBER', ''),
      bankAccountName: this.config.get<string>('BANK_ACCOUNT_NAME', ''),
      bankName: this.config.get<string>('BANK_NAME', ''),
      transferContent: order.orderCode,
      amount: order.totalAmount,
    };
  }

  // Trình duyệt khách quay về sau khi thanh toán ở VNPay — chỉ dùng để hiển thị UX ngay
  // lập tức, KHÔNG phải nguồn xác thực chính (khách có thể tự sửa query string trên
  // trình duyệt). Vẫn verify chữ ký + số tiền đầy đủ như IPN, và applyPaymentResult() là
  // idempotent nên gọi từ đây trước hay sau IPN đều an toàn.
  async verifyVnpayReturn(
    query: Record<string, string>,
  ): Promise<VnpayReturnResult> {
    const orderCode = extractOrderCode(query.vnp_TxnRef ?? '');

    if (!verifySignature(query, this.vnpayClient.getHashSecret())) {
      return {
        success: false,
        orderId: null,
        orderCode,
        message: 'Chữ ký không hợp lệ.',
      };
    }

    const order = await this.prisma.order.findUnique({ where: { orderCode } });
    if (!order) {
      return {
        success: false,
        orderId: null,
        orderCode,
        message: 'Không tìm thấy đơn hàng.',
      };
    }

    if (!this.isAmountValid(order, query.vnp_Amount)) {
      return {
        success: false,
        orderId: order.id,
        orderCode,
        message: 'Số tiền không khớp.',
      };
    }

    const vnpSuccess = query.vnp_ResponseCode === '00';
    await this.applyPaymentResult(order, vnpSuccess, query);

    const finalOrder = await this.prisma.order.findUnique({
      where: { orderCode },
    });
    const success = finalOrder?.paymentStatus === PaymentStatus.PAID;
    return {
      success,
      orderId: order.id,
      orderCode,
      message: success
        ? 'Thanh toán thành công.'
        : 'Thanh toán thất bại hoặc đã bị hủy.',
    };
  }

  // VNPay gọi server-to-server — đây là nguồn xác thực CHÍNH, phải trả đúng format ack
  // VNPay yêu cầu (RspCode/Message) để VNPay không gọi lại vô hạn.
  async handleVnpayIpn(query: Record<string, string>): Promise<VnpayIpnAck> {
    if (!verifySignature(query, this.vnpayClient.getHashSecret())) {
      this.logger.warn(
        `VNPay IPN chữ ký không hợp lệ: ${JSON.stringify(query)}`,
      );
      return { RspCode: '97', Message: 'Invalid signature' };
    }

    const orderCode = extractOrderCode(query.vnp_TxnRef ?? '');
    const order = await this.prisma.order.findUnique({ where: { orderCode } });
    if (!order) {
      return { RspCode: '01', Message: 'Order not found' };
    }

    if (!this.isAmountValid(order, query.vnp_Amount)) {
      return { RspCode: '04', Message: 'Invalid amount' };
    }

    const success = query.vnp_ResponseCode === '00';
    const { applied } = await this.applyPaymentResult(order, success, query);
    if (!applied) {
      return { RspCode: '02', Message: 'Order already confirmed' };
    }
    return { RspCode: '00', Message: 'Confirm Success' };
  }

  private assertNotYetPaid(order: Pick<Order, 'paymentStatus'>): void {
    if (order.paymentStatus === PaymentStatus.PAID) {
      throw new BadRequestException('Đơn hàng đã được thanh toán.');
    }
  }

  private isAmountValid(order: Order, vnpAmount: string | undefined): boolean {
    const expected = Math.round(order.totalAmount.toNumber() * 100);
    return Number(vnpAmount) === expected;
  }

  // Idempotent — tìm PaymentTransaction VNPAY đang PENDING mới nhất của đơn; nếu đơn đã
  // PAID hoặc không còn transaction PENDING nào (đã được IPN/Return trước đó xử lý), coi
  // như đã áp dụng rồi, không làm lại (applied: false) — an toàn khi IPN và Return cùng
  // gọi cho 1 kết quả, hoặc VNPay tự động gọi lại IPN nhiều lần.
  private async applyPaymentResult(
    order: Order,
    success: boolean,
    rawPayload: Record<string, string>,
  ): Promise<{ applied: boolean }> {
    if (order.paymentStatus === PaymentStatus.PAID) {
      return { applied: false };
    }

    const pendingTxn = await this.prisma.paymentTransaction.findFirst({
      where: {
        orderId: order.id,
        provider: PaymentProvider.VNPAY,
        status: TransactionStatus.PENDING,
      },
      orderBy: { createdAt: 'desc' },
    });
    if (!pendingTxn) {
      return { applied: false };
    }

    const operations: Prisma.PrismaPromise<unknown>[] = [
      this.prisma.paymentTransaction.update({
        where: { id: pendingTxn.id },
        data: {
          status: success
            ? TransactionStatus.SUCCESS
            : TransactionStatus.FAILED,
          providerTxnId: rawPayload.vnp_TransactionNo || undefined,
          rawPayload: rawPayload,
        },
      }),
    ];
    if (success) {
      operations.push(
        this.prisma.order.update({
          where: { id: order.id },
          data: { paymentStatus: PaymentStatus.PAID },
        }),
      );
    }

    await this.prisma.$transaction(operations);
    return { applied: true };
  }
}

// vnp_TxnRef sinh ra ở dạng "${orderCode}-${timestampBase36}" (xem initiateVnpay) —
// orderCode tự sinh (generateOrderCode ở orders.service.ts) chỉ gồm chữ hoa/số, không
// chứa "-", nên phần đầu tách theo "-" luôn đúng là orderCode gốc.
function extractOrderCode(txnRef: string): string {
  return txnRef.split('-')[0] ?? '';
}
