import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../config/prisma.service';

const PUBLIC_PROMO_BAR_SELECT = {
  id: true,
  label: true,
  highlight: true,
  linkUrl: true,
  startDate: true,
  endDate: true,
} as const;

@Injectable()
export class PromoBarsService {
  constructor(private readonly prisma: PrismaService) {}

  // Chỉ 1 thanh được hiển thị tại 1 thời điểm — lấy bản active có sortOrder thấp nhất
  // trong các thanh đang RUNNING, trả null nếu không có thanh nào đang chạy.
  findActive() {
    const now = new Date();
    return this.prisma.promoBar.findFirst({
      where: { isActive: true, startDate: { lte: now }, endDate: { gte: now } },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      select: PUBLIC_PROMO_BAR_SELECT,
    });
  }
}
