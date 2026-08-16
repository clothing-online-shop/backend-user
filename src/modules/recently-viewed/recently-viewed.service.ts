import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Product, RecentlyViewed } from '@prisma/client';
import { PrismaService } from '../../config/prisma.service';

export interface ViewerIdentity {
  userId?: string;
  guestId?: string;
}

type RecentlyViewedWithProduct = RecentlyViewed & { product: Product };

const MAX_ITEMS = 20;

@Injectable()
export class RecentlyViewedService {
  constructor(private readonly prisma: PrismaService) {}

  async recordView(identity: ViewerIdentity, productId: string): Promise<void> {
    assertIdentity(identity);

    const product = await this.prisma.product.findUnique({
      where: { id: productId },
    });
    if (!product || product.isDelete) {
      throw new NotFoundException('Không tìm thấy sản phẩm');
    }

    if (identity.userId) {
      await this.prisma.recentlyViewed.upsert({
        where: {
          userId_productId: { userId: identity.userId, productId },
        },
        update: { viewedAt: new Date() },
        create: { userId: identity.userId, productId },
      });
    } else {
      await this.prisma.recentlyViewed.upsert({
        where: {
          guestId_productId: { guestId: identity.guestId!, productId },
        },
        update: { viewedAt: new Date() },
        create: { guestId: identity.guestId!, productId },
      });
    }

    await this.pruneOldEntries(identity);
  }

  async findMyRecentlyViewed(identity: ViewerIdentity) {
    assertIdentity(identity);

    const items = await this.prisma.recentlyViewed.findMany({
      where: identityWhere(identity),
      orderBy: { viewedAt: 'desc' },
      take: MAX_ITEMS,
      include: { product: true },
    });
    return items.map(toRecentlyViewedResponse);
  }

  // Giữ tối đa MAX_ITEMS dòng mới nhất cho mỗi định danh — xóa phần dư sau mỗi lần ghi để
  // bảng không phình vô hạn (yêu cầu "lưu 10-20 sản phẩm đã xem gần đây").
  private async pruneOldEntries(identity: ViewerIdentity): Promise<void> {
    const stale = await this.prisma.recentlyViewed.findMany({
      where: identityWhere(identity),
      orderBy: { viewedAt: 'desc' },
      skip: MAX_ITEMS,
      select: { id: true },
    });
    if (stale.length === 0) return;

    await this.prisma.recentlyViewed.deleteMany({
      where: { id: { in: stale.map((s) => s.id) } },
    });
  }
}

function assertIdentity(identity: ViewerIdentity): void {
  if (!identity.userId && !identity.guestId) {
    throw new BadRequestException(
      'Thiếu thông tin định danh — cần đăng nhập hoặc gửi header X-Guest-Id.',
    );
  }
}

function identityWhere(identity: ViewerIdentity) {
  return identity.userId
    ? { userId: identity.userId }
    : { guestId: identity.guestId };
}

function toRecentlyViewedResponse(item: RecentlyViewedWithProduct) {
  return {
    id: item.id,
    productId: item.productId,
    viewedAt: item.viewedAt,
    product: {
      id: item.product.id,
      name: item.product.name,
      slug: item.product.slug,
      thumbnail: item.product.thumbnail,
      basePrice: item.product.basePrice.toNumber(),
      salePrice: item.product.salePrice?.toNumber() ?? null,
      status: item.product.status,
    },
  };
}
