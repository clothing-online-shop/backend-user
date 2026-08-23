import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  Order,
  OrderStatus,
  PaymentStatus,
  PaymentProvider,
  Prisma,
  TransactionStatus,
} from '@prisma/client';
import { PrismaService } from '../../config/prisma.service';
import { VnpayClient } from '../../common/vnpay/vnpay-client.service';
import { verifySignature } from '../../common/vnpay/vnpay-signature.util';

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
  ) {}

  // Gọi lại được nhiều lần cho cùng 1 đơn (thanh toán lại — task 2, hoặc đổi từ chuyển
  // khoản sang VNPay) — mỗi lần tạo 1 PaymentTransaction PENDING mới, không xóa lịch sử cũ.
  async initiateVnpay(
    userId: string,
    orderId: string,
    ipAddr: string,
  ): Promise<{ paymentUrl: string }> {
    const order = await this.findOwnedOrder(userId, orderId);
    this.assertPayable(order);

    const txnRef = `${order.orderCode}-${Date.now().toString(36)}`;
    await this.createPendingTransaction(order, PaymentProvider.VNPAY, {
      txnRef,
    });

    const paymentUrl = this.vnpayClient.buildPaymentUrl({
      orderCode: order.orderCode,
      txnRef,
      amount: order.totalAmount.toNumber(),
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
    const order = await this.findOwnedOrder(userId, orderId);
    this.assertPayable(order);

    await this.createPendingTransaction(order, PaymentProvider.BANK_TRANSFER);

    return {
      bankAccountNumber: this.config.get<string>('BANK_ACCOUNT_NUMBER', ''),
      bankAccountName: this.config.get<string>('BANK_ACCOUNT_NAME', ''),
      bankName: this.config.get<string>('BANK_NAME', ''),
      transferContent: order.orderCode,
      amount: order.totalAmount.toNumber(),
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

  // Payments module tự truy vấn Order trực tiếp (không phụ thuộc OrdersService của module
  // orders) — chỉ cần đúng 2 việc: kiểm tra sở hữu + đọc totalAmount/orderCode/paymentStatus,
  // không cần các field snapshot (productName/variantSku...) mà OrdersService.toOrderResponse()
  // trả về, tách biệt giúp payments module không phải đổi theo mỗi khi orders module đổi cấu
  // trúc response.
  private async findOwnedOrder(
    userId: string,
    orderId: string,
  ): Promise<Order> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
    });
    if (!order || order.userId !== userId) {
      throw new NotFoundException('Không tìm thấy đơn hàng.');
    }
    return order;
  }

  // Dùng chung cho initiateVnpay()/initiateBankTransfer(): cập nhật Order.paymentMethod theo
  // phương thức khách vừa chọn (đơn có thể đổi phương thức nhiều lần trước khi thanh toán
  // xong — thiếu bước này thì đơn đổi từ COD/chuyển khoản sang VNPay hay ngược lại vẫn đứng
  // tên paymentMethod cũ, sai lệch với PaymentTransaction.provider vừa tạo) rồi tạo 1
  // PaymentTransaction PENDING mới trong cùng transaction DB.
  private async createPendingTransaction(
    order: Pick<Order, 'id' | 'totalAmount'>,
    provider: PaymentProvider,
    rawPayload?: Prisma.InputJsonValue,
  ): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.order.update({
        where: { id: order.id },
        data: { paymentMethod: provider },
      }),
      this.prisma.paymentTransaction.create({
        data: {
          orderId: order.id,
          provider,
          amount: order.totalAmount,
          status: TransactionStatus.PENDING,
          ...(rawPayload ? { rawPayload } : {}),
        },
      }),
    ]);
  }

  private assertPayable(order: Pick<Order, 'paymentStatus' | 'status'>): void {
    if (order.paymentStatus === PaymentStatus.PAID) {
      throw new BadRequestException('Đơn hàng đã được thanh toán.');
    }
    // Đơn đã hủy (vd admin hủy vì hết hàng) không được khởi tạo thanh toán mới — thiếu check
    // này, khách vẫn mở được trang VNPay/xem được hướng dẫn chuyển khoản cho 1 đơn đã hủy và
    // trả tiền, trong khi hàng đã được hoàn kho cho khách khác từ lúc hủy.
    if (order.status === OrderStatus.CANCELLED) {
      throw new BadRequestException(
        'Đơn hàng đã bị hủy, không thể thanh toán.',
      );
    }
  }

  private isAmountValid(order: Order, vnpAmount: string | undefined): boolean {
    const expected = Math.round(order.totalAmount.toNumber() * 100);
    return Number(vnpAmount) === expected;
  }

  // Idempotent — tìm đúng PaymentTransaction VNPAY đang PENDING khớp vnp_TxnRef của chính
  // lần gọi này (không phải "PENDING mới nhất"): initiateVnpay() cho phép gọi lại nhiều lần
  // cho cùng 1 đơn, mỗi lần tạo 1 PaymentTransaction PENDING riêng với txnRef khác nhau —
  // nếu khách mở 2 link thanh toán rồi trả tiền qua link CŨ, "lấy PENDING mới nhất" sẽ đánh
  // dấu SUCCESS nhầm bản ghi (link mới, chưa ai trả tiền) thay vì bản ghi khách thực sự đã
  // trả. Nếu đơn đã PAID hoặc không còn transaction PENDING nào khớp (đã được IPN/Return
  // trước đó xử lý), coi như đã áp dụng rồi, không làm lại (applied: false) — an toàn khi
  // IPN và Return cùng gọi cho 1 kết quả, hoặc VNPay tự động gọi lại IPN nhiều lần.
  private async applyPaymentResult(
    order: Order,
    success: boolean,
    rawPayload: Record<string, string>,
  ): Promise<{ applied: boolean }> {
    if (order.paymentStatus === PaymentStatus.PAID) {
      return { applied: false };
    }

    const txnRef = rawPayload.vnp_TxnRef;
    const pendingTxn = await this.prisma.paymentTransaction.findFirst({
      where: {
        orderId: order.id,
        provider: PaymentProvider.VNPAY,
        status: TransactionStatus.PENDING,
        ...(txnRef ? { rawPayload: { path: ['txnRef'], equals: txnRef } } : {}),
      },
      orderBy: { createdAt: 'desc' },
    });
    if (!pendingTxn) {
      return { applied: false };
    }

    // Đơn bị hủy trong lúc khách đang thanh toán (tab VNPay mở từ trước khi admin hủy đơn) —
    // không đánh dấu PAID cho 1 đơn đã hủy dù VNPay báo giao dịch thành công, hàng đã được
    // hoàn kho lúc hủy rồi. Vẫn ghi lại kết quả giao dịch (không để PENDING treo mãi) để còn
    // dấu vết đối soát/hoàn tiền thủ công.
    const isCancelled = order.status === OrderStatus.CANCELLED;

    // Interactive transaction (không phải mảng operations cố định) + updateMany kèm
    // where.status: PENDING cũ — optimistic concurrency: VNPay tự retry IPN, hoặc IPN và
    // Return cùng xử lý 1 kết quả gần như đồng thời, có thể cùng findFirst trúng đúng 1
    // pendingTxn TRƯỚC khi cái nào commit. Trước đây update() theo id trần luôn "thắng" cho
    // cả 2 lần gọi, phá vỡ tính idempotent mà comment ở applyPaymentResult() đã ghi —
    // updateMany trả count=0 cho lần gọi thua cuộc (status đã đổi khỏi PENDING) để bỏ qua,
    // không áp dụng kết quả 2 lần / không tạo 2 bản ghi PAID.
    const applied = await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.paymentTransaction.updateMany({
        where: { id: pendingTxn.id, status: TransactionStatus.PENDING },
        data: {
          status:
            success && !isCancelled
              ? TransactionStatus.SUCCESS
              : TransactionStatus.FAILED,
          providerTxnId: rawPayload.vnp_TransactionNo || undefined,
          rawPayload: rawPayload,
        },
      });
      if (count === 0) {
        return false;
      }

      if (success && !isCancelled) {
        await tx.order.update({
          where: { id: order.id },
          data: { paymentStatus: PaymentStatus.PAID },
        });
      }
      return true;
    });

    return { applied };
  }
}

// vnp_TxnRef sinh ra ở dạng "${orderCode}-${timestampBase36}" (xem initiateVnpay) —
// orderCode tự sinh (generateOrderCode ở orders.service.ts) chỉ gồm chữ hoa/số, không
// chứa "-", nên phần đầu tách theo "-" luôn đúng là orderCode gốc.
function extractOrderCode(txnRef: string): string {
  return txnRef.split('-')[0] ?? '';
}
