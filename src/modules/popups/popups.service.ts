import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../config/prisma.service';

const PUBLIC_POPUP_SELECT = {
  id: true,
  eyebrow: true,
  title: true,
  description: true,
  discountCode: true,
  imageUrl: true,
  ctaLabel: true,
  ctaLinkUrl: true,
} as const;

@Injectable()
export class PopupsService {
  constructor(private readonly prisma: PrismaService) {}

  // Chỉ 1 popup được hiển thị tại 1 thời điểm — lấy bản active có sortOrder thấp nhất
  // trong các popup đang RUNNING, trả null nếu không có popup nào đang chạy.
  findActive() {
    const now = new Date();
    return this.prisma.popup.findFirst({
      where: { isActive: true, startDate: { lte: now }, endDate: { gte: now } },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      select: PUBLIC_POPUP_SELECT,
    });
  }
}
