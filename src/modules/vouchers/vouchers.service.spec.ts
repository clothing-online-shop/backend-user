import { BadRequestException, ConflictException } from '@nestjs/common';
import { DiscountType, OrderStatus, Prisma } from '@prisma/client';
import { VouchersService } from './vouchers.service';

function voucher(
  overrides: Partial<{
    id: string;
    code: string;
    discountType: DiscountType;
    discountValue: number;
    maxDiscountAmount: number | null;
    minOrderValue: number;
    startsAt: Date | null;
    expiresAt: Date | null;
    usageLimit: number | null;
    usedCount: number;
    perCustomerLimit: number | null;
    isActive: boolean;
  }> = {},
) {
  return {
    id: overrides.id ?? 'voucher-1',
    code: overrides.code ?? 'SUMMER2026',
    discountType: overrides.discountType ?? DiscountType.PERCENTAGE,
    discountValue: new Prisma.Decimal(overrides.discountValue ?? 10),
    maxDiscountAmount:
      overrides.maxDiscountAmount === undefined
        ? null
        : overrides.maxDiscountAmount === null
          ? null
          : new Prisma.Decimal(overrides.maxDiscountAmount),
    minOrderValue: new Prisma.Decimal(overrides.minOrderValue ?? 0),
    startsAt: overrides.startsAt ?? null,
    expiresAt: overrides.expiresAt ?? null,
    usageLimit: overrides.usageLimit ?? null,
    usedCount: overrides.usedCount ?? 0,
    perCustomerLimit: overrides.perCustomerLimit ?? null,
    isActive: overrides.isActive ?? true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function createClientMocks() {
  const findUnique = jest.fn();
  const updateMany = jest.fn().mockResolvedValue({ count: 1 });
  const create = jest.fn().mockResolvedValue({});
  const count = jest.fn().mockResolvedValue(0);
  const client = {
    voucher: { findUnique, updateMany },
    voucherRedemption: { count, create },
  };
  return { client, findUnique, updateMany, create, count };
}

describe('VouchersService.validateAndCompute', () => {
  it('voucher PERCENTAGE có trần giảm — discount = min(subtotal * %, trần)', async () => {
    const { client, findUnique } = createClientMocks();
    findUnique.mockResolvedValue(
      voucher({
        discountType: DiscountType.PERCENTAGE,
        discountValue: 20,
        maxDiscountAmount: 50000,
      }),
    );
    const service = new VouchersService({} as never);

    const { discountAmount } = await service.validateAndCompute(
      client,
      'user-1',
      'summer2026',
      new Prisma.Decimal(500000),
    );

    // 500000 * 20% = 100000, vượt trần 50000 → chốt ở trần.
    expect(discountAmount.toNumber()).toBe(50000);
  });

  it('voucher PERCENTAGE không có trần — discount = subtotal * %', async () => {
    const { client, findUnique } = createClientMocks();
    findUnique.mockResolvedValue(
      voucher({ discountType: DiscountType.PERCENTAGE, discountValue: 10 }),
    );
    const service = new VouchersService({} as never);

    const { discountAmount } = await service.validateAndCompute(
      client,
      'user-1',
      'summer2026',
      new Prisma.Decimal(200000),
    );

    expect(discountAmount.toNumber()).toBe(20000);
  });

  it('voucher FIXED_AMOUNT lớn hơn subtotal — discount bị chặn lại ở đúng subtotal, không âm', async () => {
    const { client, findUnique } = createClientMocks();
    findUnique.mockResolvedValue(
      voucher({
        discountType: DiscountType.FIXED_AMOUNT,
        discountValue: 100000,
      }),
    );
    const service = new VouchersService({} as never);

    const { discountAmount } = await service.validateAndCompute(
      client,
      'user-1',
      'summer2026',
      new Prisma.Decimal(50000),
    );

    expect(discountAmount.toNumber()).toBe(50000);
  });

  it('mã voucher không tồn tại → BadRequestException', async () => {
    const { client, findUnique } = createClientMocks();
    findUnique.mockResolvedValue(null);
    const service = new VouchersService({} as never);

    await expect(
      service.validateAndCompute(
        client,
        'user-1',
        'NOTEXIST',
        new Prisma.Decimal(100000),
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('voucher bị vô hiệu hóa (isActive=false) → BadRequestException', async () => {
    const { client, findUnique } = createClientMocks();
    findUnique.mockResolvedValue(voucher({ isActive: false }));
    const service = new VouchersService({} as never);

    await expect(
      service.validateAndCompute(
        client,
        'user-1',
        'summer2026',
        new Prisma.Decimal(100000),
      ),
    ).rejects.toThrow('Voucher đã bị vô hiệu hóa.');
  });

  it('chưa tới ngày bắt đầu (startsAt ở tương lai) → BadRequestException', async () => {
    const { client, findUnique } = createClientMocks();
    const future = new Date(Date.now() + 86400000);
    findUnique.mockResolvedValue(voucher({ startsAt: future }));
    const service = new VouchersService({} as never);

    await expect(
      service.validateAndCompute(
        client,
        'user-1',
        'summer2026',
        new Prisma.Decimal(100000),
      ),
    ).rejects.toThrow('Voucher chưa tới thời gian áp dụng.');
  });

  it('đã hết hạn (expiresAt ở quá khứ) → BadRequestException', async () => {
    const { client, findUnique } = createClientMocks();
    const past = new Date(Date.now() - 86400000);
    findUnique.mockResolvedValue(voucher({ expiresAt: past }));
    const service = new VouchersService({} as never);

    await expect(
      service.validateAndCompute(
        client,
        'user-1',
        'summer2026',
        new Prisma.Decimal(100000),
      ),
    ).rejects.toThrow('Voucher đã hết hạn sử dụng.');
  });

  it('subtotal chưa đạt minOrderValue → BadRequestException', async () => {
    const { client, findUnique } = createClientMocks();
    findUnique.mockResolvedValue(voucher({ minOrderValue: 300000 }));
    const service = new VouchersService({} as never);

    await expect(
      service.validateAndCompute(
        client,
        'user-1',
        'summer2026',
        new Prisma.Decimal(200000),
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('đã hết tổng lượt sử dụng (usedCount >= usageLimit) → BadRequestException', async () => {
    const { client, findUnique } = createClientMocks();
    findUnique.mockResolvedValue(voucher({ usageLimit: 5, usedCount: 5 }));
    const service = new VouchersService({} as never);

    await expect(
      service.validateAndCompute(
        client,
        'user-1',
        'summer2026',
        new Prisma.Decimal(100000),
      ),
    ).rejects.toThrow('Voucher đã hết lượt sử dụng.');
  });

  it('khách đã dùng hết lượt cho phép/khách (perCustomerLimit) → BadRequestException, đếm đúng loại trừ đơn CANCELLED', async () => {
    const { client, findUnique, count } = createClientMocks();
    findUnique.mockResolvedValue(voucher({ perCustomerLimit: 1 }));
    count.mockResolvedValue(1);
    const service = new VouchersService({} as never);

    await expect(
      service.validateAndCompute(
        client,
        'user-1',
        'summer2026',
        new Prisma.Decimal(100000),
      ),
    ).rejects.toThrow('Bạn đã dùng hết lượt cho voucher này.');
    expect(count).toHaveBeenCalledWith({
      where: {
        voucherId: 'voucher-1',
        userId: 'user-1',
        order: { status: { not: OrderStatus.CANCELLED } },
      },
    });
  });

  it('mã voucher khách nhập không đúng hoa/thường + có khoảng trắng thừa vẫn khớp đúng (chuẩn hóa trước khi tra)', async () => {
    const { client, findUnique } = createClientMocks();
    findUnique.mockResolvedValue(voucher({ code: 'SUMMER2026' }));
    const service = new VouchersService({} as never);

    await service.validateAndCompute(
      client,
      'user-1',
      '  summer2026  ',
      new Prisma.Decimal(100000),
    );

    expect(findUnique).toHaveBeenCalledWith({ where: { code: 'SUMMER2026' } });
  });
});

describe('VouchersService.redeem', () => {
  it('còn lượt — updateMany khớp, tăng usedCount + ghi VoucherRedemption', async () => {
    const { client, updateMany, create } = createClientMocks();
    const service = new VouchersService({} as never);
    const v = voucher({ usageLimit: 10, usedCount: 3 });

    await service.redeem(
      client as never,
      v,
      'user-1',
      'order-1',
      new Prisma.Decimal(20000),
    );

    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 'voucher-1', usedCount: { lt: 10 } },
      data: { usedCount: { increment: 1 } },
    });
    expect(create).toHaveBeenCalledWith({
      data: {
        voucherId: 'voucher-1',
        userId: 'user-1',
        orderId: 'order-1',
        discountAmount: new Prisma.Decimal(20000),
      },
    });
  });

  it('voucher không giới hạn tổng lượt (usageLimit=null) — updateMany không kèm điều kiện usedCount', async () => {
    const { client, updateMany } = createClientMocks();
    const service = new VouchersService({} as never);
    const v = voucher({ usageLimit: null });

    await service.redeem(
      client as never,
      v,
      'user-1',
      'order-1',
      new Prisma.Decimal(20000),
    );

    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 'voucher-1' },
      data: { usedCount: { increment: 1 } },
    });
  });
});

describe('VouchersService.listEligible', () => {
  function createPrismaMock() {
    const findMany = jest.fn();
    const count = jest.fn().mockResolvedValue(0);
    const prisma = {
      voucher: { findMany },
      voucherRedemption: { count },
    };
    return { prisma, findMany, count };
  }

  it('trả về voucher đủ điều kiện, bỏ qua voucher không đạt minOrderValue', async () => {
    const { prisma, findMany } = createPrismaMock();
    findMany.mockResolvedValue([
      voucher({
        id: 'v-ok',
        code: 'OK10',
        discountValue: 10,
        minOrderValue: 0,
      }),
      voucher({
        id: 'v-toohigh',
        code: 'NEEDS500K',
        minOrderValue: 500000,
      }),
    ]);
    const service = new VouchersService(prisma as never);

    const result = await service.listEligible(
      'user-1',
      new Prisma.Decimal(200000),
    );

    expect(result.map((r) => r.voucher.code)).toEqual(['OK10']);
    expect(result[0].discountAmount.toNumber()).toBe(20000);
  });

  it('bỏ qua voucher khách đã dùng hết lượt/khách (perCustomerLimit)', async () => {
    const { prisma, findMany, count } = createPrismaMock();
    findMany.mockResolvedValue([
      voucher({ id: 'v-used-up', code: 'USEDUP', perCustomerLimit: 1 }),
    ]);
    count.mockResolvedValue(1);
    const service = new VouchersService(prisma as never);

    const result = await service.listEligible(
      'user-1',
      new Prisma.Decimal(100000),
    );

    expect(result).toEqual([]);
  });

  it('sắp theo discountAmount giảm dần (voucher lợi nhất lên đầu)', async () => {
    const { prisma, findMany } = createPrismaMock();
    findMany.mockResolvedValue([
      voucher({ id: 'v-small', code: 'SMALL5', discountValue: 5 }),
      voucher({ id: 'v-big', code: 'BIG20', discountValue: 20 }),
    ]);
    const service = new VouchersService(prisma as never);

    const result = await service.listEligible(
      'user-1',
      new Prisma.Decimal(100000),
    );

    expect(result.map((r) => r.voucher.code)).toEqual(['BIG20', 'SMALL5']);
  });

  it('query findMany chỉ lọc isActive + trong khoảng thời gian hiệu lực ở DB (usageLimit/perCustomerLimit đánh giá riêng ở tầng ứng dụng)', async () => {
    const { prisma, findMany } = createPrismaMock();
    findMany.mockResolvedValue([]);
    const service = new VouchersService(prisma as never);

    await service.listEligible('user-1', new Prisma.Decimal(100000));

    expect(findMany).toHaveBeenCalledWith({
      where: {
        isActive: true,
        startsAt: { lte: expect.any(Date) as Date },
        OR: [
          { expiresAt: null },
          { expiresAt: { gte: expect.any(Date) as Date } },
        ],
      },
    });
  });
});

describe('VouchersService.redeem', () => {
  it('race: request khác vừa dùng hết lượt cuối trước — updateMany count=0 → ConflictException, không ghi VoucherRedemption', async () => {
    const { client, updateMany, create } = createClientMocks();
    updateMany.mockResolvedValue({ count: 0 });
    const service = new VouchersService({} as never);
    const v = voucher({ usageLimit: 1, usedCount: 1 });

    await expect(
      service.redeem(
        client as never,
        v,
        'user-1',
        'order-1',
        new Prisma.Decimal(20000),
      ),
    ).rejects.toThrow(ConflictException);
    expect(create).not.toHaveBeenCalled();
  });
});
