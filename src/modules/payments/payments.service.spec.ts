import { ConfigService } from '@nestjs/config';
import {
  PaymentStatus,
  PaymentProvider,
  TransactionStatus,
} from '@prisma/client';
import { PaymentsService } from './payments.service';
import { PrismaService } from '../../config/prisma.service';
import { VnpayClient } from '../../common/vnpay/vnpay-client.service';
import { OrdersService } from '../orders/orders.service';
import { buildSignedQuery } from '../../common/vnpay/vnpay-signature.util';

const HASH_SECRET = 'TESTSECRETKEYFORLOCALDEVONLY123';

function amountDecimal(value: number) {
  return { toNumber: () => value };
}

function pendingVnpayTxn(overrides: Partial<{ id: string }> = {}) {
  return {
    id: overrides.id ?? 'txn-1',
    orderId: 'order-1',
    provider: PaymentProvider.VNPAY,
    status: TransactionStatus.PENDING,
    createdAt: new Date(),
  };
}

function order(overrides: Partial<{ paymentStatus: PaymentStatus }> = {}) {
  return {
    id: 'order-1',
    orderCode: 'ORDABC123',
    totalAmount: amountDecimal(100000),
    paymentStatus: overrides.paymentStatus ?? PaymentStatus.UNPAID,
  };
}

function createMocks() {
  const orderFindUnique = jest.fn();
  const paymentTransactionFindFirst = jest.fn();
  const paymentTransactionUpdate = jest.fn();
  const orderUpdate = jest.fn();
  const transaction = jest.fn((ops: unknown[]) =>
    Promise.all(ops as Promise<unknown>[]),
  );

  const prisma = {
    order: { findUnique: orderFindUnique, update: orderUpdate },
    paymentTransaction: {
      findFirst: paymentTransactionFindFirst,
      update: paymentTransactionUpdate,
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

  const findOwnedOrder = jest.fn();
  const ordersService = { findOwnedOrder } as unknown as OrdersService;

  return {
    prisma,
    orderFindUnique,
    paymentTransactionFindFirst,
    paymentTransactionUpdate,
    orderUpdate,
    transaction,
    config,
    vnpayClient,
    buildPaymentUrl,
    ordersService,
    findOwnedOrder,
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
      const { prisma, config, vnpayClient, ordersService, orderUpdate } =
        createMocks();
      const service = new PaymentsService(
        prisma,
        config,
        vnpayClient,
        ordersService,
      );

      const query = signedIpnQuery();
      query.vnp_SecureHash = 'tampered' + query.vnp_SecureHash.slice(8);

      const ack = await service.handleVnpayIpn(query);
      expect(ack.RspCode).toBe('97');
      expect(orderUpdate).not.toHaveBeenCalled();
    });

    it('số tiền không khớp thì trả RspCode 04', async () => {
      const {
        prisma,
        orderFindUnique,
        config,
        vnpayClient,
        ordersService,
        orderUpdate,
      } = createMocks();
      orderFindUnique.mockResolvedValue(order());
      const service = new PaymentsService(
        prisma,
        config,
        vnpayClient,
        ordersService,
      );

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
        ordersService,
        transaction,
      } = createMocks();
      orderFindUnique.mockResolvedValue(order());
      paymentTransactionFindFirst.mockResolvedValue(pendingVnpayTxn());
      const service = new PaymentsService(
        prisma,
        config,
        vnpayClient,
        ordersService,
      );

      const query = signedIpnQuery();
      const ack = await service.handleVnpayIpn(query);

      expect(ack.RspCode).toBe('00');
      expect(transaction).toHaveBeenCalledTimes(1);
    });

    it('idempotent — gọi lần 2 (đơn đã PAID) không áp dụng lại, trả RspCode 02', async () => {
      const {
        prisma,
        orderFindUnique,
        config,
        vnpayClient,
        ordersService,
        transaction,
      } = createMocks();
      orderFindUnique.mockResolvedValue(
        order({ paymentStatus: PaymentStatus.PAID }),
      );
      const service = new PaymentsService(
        prisma,
        config,
        vnpayClient,
        ordersService,
      );

      const query = signedIpnQuery();
      const ack = await service.handleVnpayIpn(query);

      expect(ack.RspCode).toBe('02');
      expect(transaction).not.toHaveBeenCalled();
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
        ordersService,
      } = createMocks();
      orderFindUnique
        .mockResolvedValueOnce(order())
        .mockResolvedValueOnce(order({ paymentStatus: PaymentStatus.PAID }));
      paymentTransactionFindFirst.mockResolvedValue(pendingVnpayTxn());
      const service = new PaymentsService(
        prisma,
        config,
        vnpayClient,
        ordersService,
      );

      const result = await service.verifyVnpayReturn(signedIpnQuery());
      expect(result.success).toBe(true);
      expect(result.orderCode).toBe('ORDABC123');
    });
  });
});
