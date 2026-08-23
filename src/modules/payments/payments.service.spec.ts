import { ConfigService } from '@nestjs/config';
import {
  OrderStatus,
  PaymentStatus,
  PaymentProvider,
  TransactionStatus,
} from '@prisma/client';
import { PaymentsService } from './payments.service';
import { PrismaService } from '../../config/prisma.service';
import { VnpayClient } from '../../common/vnpay/vnpay-client.service';
import { buildSignedQuery } from '../../common/vnpay/vnpay-signature.util';

const HASH_SECRET = 'TESTSECRETKEYFORLOCALDEVONLY123';

function amountDecimal(value: number) {
  return { toNumber: () => value };
}

function pendingVnpayTxn(
  overrides: Partial<{ id: string; txnRef: string }> = {},
) {
  return {
    id: overrides.id ?? 'txn-1',
    orderId: 'order-1',
    provider: PaymentProvider.VNPAY,
    status: TransactionStatus.PENDING,
    rawPayload: { txnRef: overrides.txnRef ?? 'ORDABC123-abc123' },
    createdAt: new Date(),
  };
}

function order(
  overrides: Partial<{
    paymentStatus: PaymentStatus;
    status: OrderStatus;
  }> = {},
) {
  return {
    id: 'order-1',
    orderCode: 'ORDABC123',
    totalAmount: amountDecimal(100000),
    paymentStatus: overrides.paymentStatus ?? PaymentStatus.UNPAID,
    status: overrides.status ?? OrderStatus.CONFIRMED,
  };
}

function createMocks() {
  const orderFindUnique = jest.fn();
  const paymentTransactionFindFirst = jest.fn();
  const paymentTransactionUpdateMany = jest
    .fn()
    .mockResolvedValue({ count: 1 });
  const orderUpdate = jest.fn();
  // $transaction() được gọi ở 2 dạng khác nhau trong payments.service.ts: dạng mảng
  // operations cố định (createPendingTransaction — không cần đọc kết quả 1 query để quyết
  // định query khác) và dạng callback interactive (applyPaymentResult — cần đọc count từ
  // updateMany trước khi quyết định có update Order hay không, xem comment tại đó). Mock
  // phải hỗ trợ cả 2 dạng, không chỉ 1 như trước.
  const transaction = jest.fn((arg: unknown) => {
    if (typeof arg === 'function') {
      const tx = {
        paymentTransaction: { updateMany: paymentTransactionUpdateMany },
        order: { update: orderUpdate },
      };
      return (arg as (tx: unknown) => Promise<unknown>)(tx);
    }
    return Promise.all(arg as Promise<unknown>[]);
  });

  const prisma = {
    order: { findUnique: orderFindUnique, update: orderUpdate },
    paymentTransaction: {
      findFirst: paymentTransactionFindFirst,
      updateMany: paymentTransactionUpdateMany,
    },
    $transaction: transaction,
  } as unknown as PrismaService;

  const values: Record<string, string> = {};
  const config = {
    get: jest.fn((key: string, def?: string) => values[key] ?? def),
  } as unknown as ConfigService;

  const buildPaymentUrl = jest
    .fn()
    .mockReturnValue('https://sandbox.vnpayment.vn/pay?signed=1');
  const vnpayClient = {
    getHashSecret: () => HASH_SECRET,
    buildPaymentUrl,
  } as unknown as VnpayClient;

  return {
    prisma,
    orderFindUnique,
    paymentTransactionFindFirst,
    paymentTransactionUpdateMany,
    orderUpdate,
    transaction,
    config,
    vnpayClient,
    buildPaymentUrl,
  };
}

function signedIpnQuery(overrides: Record<string, string> = {}) {
  const params = {
    vnp_TxnRef: 'ORDABC123-abc123',
    vnp_Amount: '10000000',
    vnp_ResponseCode: '00',
    vnp_TransactionNo: '14000123',
    ...overrides,
  };
  const signedQuery = buildSignedQuery(params, HASH_SECRET);
  const result: Record<string, string> = {};
  for (const pair of signedQuery.split('&')) {
    const [key, value] = pair.split('=');
    result[key] = decodeURIComponent(value.replace(/\+/g, '%20'));
  }
  return result;
}

describe('PaymentsService', () => {
  describe('handleVnpayIpn', () => {
    it('chữ ký sai thì trả RspCode 97, không đổi trạng thái đơn', async () => {
      const { prisma, config, vnpayClient, orderUpdate } = createMocks();
      const service = new PaymentsService(prisma, config, vnpayClient);

      const query = signedIpnQuery();
      query.vnp_SecureHash = 'tampered' + query.vnp_SecureHash.slice(8);

      const ack = await service.handleVnpayIpn(query);
      expect(ack.RspCode).toBe('97');
      expect(orderUpdate).not.toHaveBeenCalled();
    });

    it('số tiền không khớp thì trả RspCode 04', async () => {
      const { prisma, orderFindUnique, config, vnpayClient, orderUpdate } =
        createMocks();
      orderFindUnique.mockResolvedValue(order());
      const service = new PaymentsService(prisma, config, vnpayClient);

      const query = signedIpnQuery({ vnp_Amount: '1' });
      const ack = await service.handleVnpayIpn(query);

      expect(ack.RspCode).toBe('04');
      expect(orderUpdate).not.toHaveBeenCalled();
    });

    it('thành công: cập nhật transaction SUCCESS + order PAID, ack RspCode 00', async () => {
      const {
        prisma,
        orderFindUnique,
        paymentTransactionFindFirst,
        config,
        vnpayClient,
        transaction,
      } = createMocks();
      orderFindUnique.mockResolvedValue(order());
      paymentTransactionFindFirst.mockResolvedValue(pendingVnpayTxn());
      const service = new PaymentsService(prisma, config, vnpayClient);

      const query = signedIpnQuery();
      const ack = await service.handleVnpayIpn(query);

      expect(ack.RspCode).toBe('00');
      expect(transaction).toHaveBeenCalledTimes(1);
      // Phải tra đúng transaction khớp vnp_TxnRef của lần callback này, không phải lấy đại
      // "PENDING mới nhất" — xem comment applyPaymentResult() trong payments.service.ts.
      const expectedWhere = expect.objectContaining({
        rawPayload: { path: ['txnRef'], equals: query.vnp_TxnRef },
      }) as unknown as Record<string, unknown>;
      const expectedFindFirstArgs = expect.objectContaining({
        where: expectedWhere,
      }) as unknown as Record<string, unknown>;
      expect(paymentTransactionFindFirst).toHaveBeenCalledWith(
        expectedFindFirstArgs,
      );
    });

    it('idempotent — gọi lần 2 (đơn đã PAID) không áp dụng lại, trả RspCode 02', async () => {
      const { prisma, orderFindUnique, config, vnpayClient, transaction } =
        createMocks();
      orderFindUnique.mockResolvedValue(
        order({ paymentStatus: PaymentStatus.PAID }),
      );
      const service = new PaymentsService(prisma, config, vnpayClient);

      const query = signedIpnQuery();
      const ack = await service.handleVnpayIpn(query);

      expect(ack.RspCode).toBe('02');
      expect(transaction).not.toHaveBeenCalled();
    });

    it('race: 2 lệnh gọi cùng khớp 1 pendingTxn, lệnh thua cuộc (updateMany count=0) KHÔNG áp dụng lại, không đổi paymentStatus lần 2', async () => {
      const {
        prisma,
        orderFindUnique,
        paymentTransactionFindFirst,
        paymentTransactionUpdateMany,
        orderUpdate,
        config,
        vnpayClient,
      } = createMocks();
      orderFindUnique.mockResolvedValue(order());
      paymentTransactionFindFirst.mockResolvedValue(pendingVnpayTxn());
      // Giả lập request khác đã update trước (status đã đổi khỏi PENDING) — updateMany của
      // request này khớp where.id nhưng không còn khớp where.status: PENDING, count=0.
      paymentTransactionUpdateMany.mockResolvedValue({ count: 0 });
      const service = new PaymentsService(prisma, config, vnpayClient);

      const ack = await service.handleVnpayIpn(signedIpnQuery());

      expect(ack.RspCode).toBe('02');
      expect(orderUpdate).not.toHaveBeenCalled();
    });

    it('đơn đã bị hủy trong lúc chờ thanh toán: KHÔNG đánh dấu PAID, transaction chuyển FAILED', async () => {
      const {
        prisma,
        orderFindUnique,
        paymentTransactionFindFirst,
        paymentTransactionUpdateMany,
        orderUpdate,
        config,
        vnpayClient,
      } = createMocks();
      orderFindUnique.mockResolvedValue(
        order({ status: OrderStatus.CANCELLED }),
      );
      paymentTransactionFindFirst.mockResolvedValue(pendingVnpayTxn());
      const service = new PaymentsService(prisma, config, vnpayClient);

      const ack = await service.handleVnpayIpn(signedIpnQuery());

      // Vẫn ack "Confirm Success" với VNPay (giao dịch phía VNPay thực sự thành công, đây
      // không phải lỗi hệ thống) nhưng KHÔNG đánh dấu đơn đã hủy là đã thanh toán.
      expect(ack.RspCode).toBe('00');
      expect(orderUpdate).not.toHaveBeenCalled();
      const expectedFailedData = expect.objectContaining({
        status: TransactionStatus.FAILED,
      }) as unknown as Record<string, unknown>;
      const expectedFailedUpdateArgs = expect.objectContaining({
        data: expectedFailedData,
      }) as unknown as Record<string, unknown>;
      expect(paymentTransactionUpdateMany).toHaveBeenCalledWith(
        expectedFailedUpdateArgs,
      );
    });

    it('khách mở 2 link thanh toán, trả tiền qua link CŨ: chỉ transaction khớp đúng txnRef được đánh dấu SUCCESS', async () => {
      const {
        prisma,
        orderFindUnique,
        paymentTransactionFindFirst,
        paymentTransactionUpdateMany,
        config,
        vnpayClient,
      } = createMocks();
      orderFindUnique.mockResolvedValue(order());
      const oldTxn = pendingVnpayTxn({
        id: 'txn-old',
        txnRef: 'ORDABC123-abc123',
      });
      const newerTxn = pendingVnpayTxn({
        id: 'txn-newer',
        txnRef: 'ORDABC123-zzz999',
      });
      // Giả lập Prisma lọc theo where.rawPayload.equals — mock findFirst thật này khác các
      // mock khác trong file (chỉ trả cố định), cần tự so khớp vì test đang xác nhận đúng
      // hành vi lọc, không phải hành vi gọi sau khi lọc.
      paymentTransactionFindFirst.mockImplementation(
        (args: {
          where: { rawPayload?: { path: string[]; equals: string } };
        }) => {
          const txnRef = args.where.rawPayload?.equals;
          const candidates = [oldTxn, newerTxn];
          return Promise.resolve(
            candidates.find((t) => t.rawPayload.txnRef === txnRef) ?? null,
          );
        },
      );
      const service = new PaymentsService(prisma, config, vnpayClient);

      // Callback thực tế mang txnRef của link CŨ (khách trả tiền qua link đó).
      const ack = await service.handleVnpayIpn(signedIpnQuery());

      expect(ack.RspCode).toBe('00');
      const expectedOldTxnWhere = expect.objectContaining({
        id: 'txn-old',
      }) as unknown as Record<string, unknown>;
      const expectedUpdateManyArgs = expect.objectContaining({
        where: expectedOldTxnWhere,
      }) as unknown as Record<string, unknown>;
      expect(paymentTransactionUpdateMany).toHaveBeenCalledWith(
        expectedUpdateManyArgs,
      );
    });
  });

  describe('verifyVnpayReturn', () => {
    it('chữ ký hợp lệ + thanh toán thành công -> success true', async () => {
      const {
        prisma,
        orderFindUnique,
        paymentTransactionFindFirst,
        config,
        vnpayClient,
      } = createMocks();
      orderFindUnique
        .mockResolvedValueOnce(order())
        .mockResolvedValueOnce(order({ paymentStatus: PaymentStatus.PAID }));
      paymentTransactionFindFirst.mockResolvedValue(pendingVnpayTxn());
      const service = new PaymentsService(prisma, config, vnpayClient);

      const result = await service.verifyVnpayReturn(signedIpnQuery());
      expect(result.success).toBe(true);
      expect(result.orderCode).toBe('ORDABC123');
    });
  });
});
