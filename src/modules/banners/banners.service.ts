import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../config/prisma.service';

const PUBLIC_BANNER_SELECT = {
  id: true,
  title: true,
  subtitle: true,
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
  findActive() {
    const now = new Date();
    return this.prisma.banner.findMany({
      where: { isActive: true, startDate: { lte: now }, endDate: { gte: now } },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      select: PUBLIC_BANNER_SELECT,
    });
  }
}
