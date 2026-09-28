import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../config/prisma.service';

const PUBLIC_BANNER_SELECT = {
  id: true,
  eyebrow: true,
  title: true,
  description: true,
  imageUrl: true,
  linkUrl: true,
  ctaLabel: true,
  ctaLinkUrl: true,
  sortOrder: true,
} as const;

@Injectable()
export class BannersService {
  constructor(private readonly prisma: PrismaService) {}

  // Chỉ trả banner đang isActive VÀ nằm trong khoảng startDate/endDate (RUNNING) — banner
  // UPCOMING/ENDED không public, khác trang quản trị (backend-cms) vẫn thấy hết để lên lịch.
  // startDate/endDate có thể để trống ở admin (bỏ trống = không giới hạn) — thiếu startDate
  // coi như đã bắt đầu, thiếu endDate coi như chạy mãi mãi, nên không thể lọc lte/gte thẳng
  // (so sánh với null luôn ra false, sẽ vô tình ẩn mất banner "chạy mãi mãi").
  findActive() {
    const now = new Date();
    return this.prisma.banner.findMany({
      where: {
        isActive: true,
        AND: [
          { OR: [{ startDate: null }, { startDate: { lte: now } }] },
          { OR: [{ endDate: null }, { endDate: { gte: now } }] },
        ],
      },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      select: PUBLIC_BANNER_SELECT,
    });
  }
}
