import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import { DiscountType, OrderStatus, Prisma, Voucher } from '@prisma/client';
import { PrismaService } from '../../config/prisma.service';

type VoucherReadClient = Pick<
  Prisma.TransactionClient,
  'voucher' | 'voucherRedemption'
>;

type EligibilityResult =
  | { eligible: true; discountAmount: Prisma.Decimal }
  | { eligible: false; reason: string };

@Injectable()
export class VouchersService {
  constructor(private readonly prisma: PrismaService) {}

  // Dùng cho GET preview (/vouchers/validate, ngoài transaction) LẪN bước tạo đơn thật bên
  // trong transaction của OrdersService.createOrder (truyền `tx` thay vì `this.prisma`, với
  // subtotal tính từ giá đã FOR UPDATE) — cùng 1 bộ điều kiện, chỉ khác client/subtotal đầu
  // vào, tránh 2 nơi tự viết 2 bản luật áp mã lệch nhau.
  async validateAndCompute(
    client: VoucherReadClient,
    userId: string,
    code: string,
    subtotal: Prisma.Decimal,
  ): Promise<{ voucher: Voucher; discountAmount: Prisma.Decimal }> {
    const normalized = code.trim().toUpperCase();
    const voucher = await client.voucher.findUnique({
      where: { code: normalized },
    });
    if (!voucher) {
      throw new BadRequestException('Mã voucher không tồn tại.');
    }

    const result = await this.evaluateEligibility(
      client,
      voucher,
      userId,
      subtotal,
    );
    if (!result.eligible) {
      throw new BadRequestException(result.reason);
    }
    return { voucher, discountAmount: result.discountAmount };
  }

  // Danh sách voucher đơn hàng hiện tại (theo subtotal của các dòng giỏ hàng đã chọn) ĐANG
  // đủ điều kiện dùng — dùng cho màn chọn voucher lúc checkout (khách không cần tự biết mã).
  // Dùng chung evaluateEligibility() với validateAndCompute() — cùng 6 điều kiện, chỉ khác
  // validateAndCompute() throw ngay ở điều kiện đầu tiên fail (áp cho 1 mã người dùng tự
  // nhập), còn ở đây lặp qua toàn bộ voucher rồi lặng lẽ bỏ qua voucher không đạt (không phải
  // lỗi — khách chỉ đang xem những mã dùng được).
  async listEligible(
    userId: string,
    subtotal: Prisma.Decimal,
  ): Promise<{ voucher: Voucher; discountAmount: Prisma.Decimal }[]> {
    const now = new Date();
    // Thu hẹp trước ở DB những điều kiện dịch được thẳng sang where() (isActive/thời gian) —
    // usageLimit/perCustomerLimit phụ thuộc usedCount/voucherRedemption nên vẫn phải đánh giá
    // từng voucher ở evaluateEligibility() bên dưới.
    const candidates = await this.prisma.voucher.findMany({
      where: {
        isActive: true,
        startsAt: { lte: now },
        OR: [{ expiresAt: null }, { expiresAt: { gte: now } }],
      },
    });

    const results = await Promise.all(
      candidates.map(async (voucher) => ({
        voucher,
        result: await this.evaluateEligibility(
          this.prisma,
          voucher,
          userId,
          subtotal,
        ),
      })),
    );

    return results
      .filter(
        (
          item,
        ): item is {
          voucher: Voucher;
          result: { eligible: true; discountAmount: Prisma.Decimal };
        } => item.result.eligible,
      )
      .map(({ voucher, result }) => ({
        voucher,
        discountAmount: result.discountAmount,
      }))
      .sort((a, b) => b.discountAmount.comparedTo(a.discountAmount));
  }

  private async evaluateEligibility(
    client: VoucherReadClient,
    voucher: Voucher,
    userId: string,
    subtotal: Prisma.Decimal,
  ): Promise<EligibilityResult> {
    if (!voucher.isActive) {
      return { eligible: false, reason: 'Voucher đã bị vô hiệu hóa.' };
    }
    const now = new Date();
    if (voucher.startsAt && now < voucher.startsAt) {
      return { eligible: false, reason: 'Voucher chưa tới thời gian áp dụng.' };
    }
    if (voucher.expiresAt && now > voucher.expiresAt) {
      return { eligible: false, reason: 'Voucher đã hết hạn sử dụng.' };
    }
    if (subtotal.lt(voucher.minOrderValue)) {
      return {
        eligible: false,
        reason: `Đơn hàng cần tối thiểu ${voucher.minOrderValue.toString()} để áp dụng voucher này.`,
      };
    }
    if (
      voucher.usageLimit !== null &&
      voucher.usedCount >= voucher.usageLimit
    ) {
      return { eligible: false, reason: 'Voucher đã hết lượt sử dụng.' };
    }
    if (voucher.perCustomerLimit !== null) {
      // Không tính đơn CANCELLED vào số lượt đã dùng — huỷ đơn coi như hoàn lại lượt, khớp
      // hành vi redeem()/OrdersService (backend-cms) hoàn usedCount khi huỷ đơn có voucher.
      const usedByCustomer = await client.voucherRedemption.count({
        where: {
          voucherId: voucher.id,
          userId,
          order: { status: { not: OrderStatus.CANCELLED } },
        },
      });
      if (usedByCustomer >= voucher.perCustomerLimit) {
        return {
          eligible: false,
          reason: 'Bạn đã dùng hết lượt cho voucher này.',
        };
      }
    }

    return {
      eligible: true,
      discountAmount: computeDiscount(voucher, subtotal),
    };
  }

  // Gọi trong transaction tạo đơn, sau khi Order đã có id. updateMany với điều kiện
  // usedCount < usageLimit là chốt chặn nguyên tử thật sự cho usageLimit — validateAndCompute()
  // ở trên chỉ đọc "lạc quan" (đủ để từ chối sớm phần lớn trường hợp, không đủ để chống race:
  // 2 request cùng pass qua đó khi voucher còn đúng 1 lượt vẫn có thể cùng vào tới đây).
  async redeem(
    tx: Prisma.TransactionClient,
    voucher: Voucher,
    userId: string,
    orderId: string,
    discountAmount: Prisma.Decimal,
  ): Promise<void> {
    const { count } = await tx.voucher.updateMany({
      where: {
        id: voucher.id,
        ...(voucher.usageLimit !== null
          ? { usedCount: { lt: voucher.usageLimit } }
          : {}),
      },
      data: { usedCount: { increment: 1 } },
    });
    if (count === 0) {
      throw new ConflictException(
        'Voucher vừa hết lượt sử dụng, vui lòng thử lại.',
      );
    }

    await tx.voucherRedemption.create({
      data: { voucherId: voucher.id, userId, orderId, discountAmount },
    });
  }
}

function computeDiscount(
  voucher: Voucher,
  subtotal: Prisma.Decimal,
): Prisma.Decimal {
  let discount =
    voucher.discountType === DiscountType.PERCENTAGE
      ? subtotal.mul(voucher.discountValue).div(100)
      : voucher.discountValue;
  if (
    voucher.maxDiscountAmount !== null &&
    discount.gt(voucher.maxDiscountAmount)
  ) {
    discount = voucher.maxDiscountAmount;
  }
  // Không bao giờ giảm nhiều hơn giá trị đơn — vd voucher giảm cố định 100k nhưng subtotal
  // chỉ còn 50k thì discount phải chặn lại ở 50k, không được để totalAmount âm.
  if (discount.gt(subtotal)) {
    discount = subtotal;
  }
  return discount;
}
