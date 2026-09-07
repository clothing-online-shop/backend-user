import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../config/prisma.service';

export interface SearcherIdentity {
  userId?: string;
  guestId?: string;
}

// Yêu cầu "lịch sử search lấy 5 cái mới nhất" — khác RecentlyViewed (MAX_ITEMS=20, xem
// recently-viewed.service.ts) vì mục đích khác nhau: đây chỉ để gợi ý nhanh vài từ khoá vừa
// gõ, không phải danh sách duyệt lại như sản phẩm đã xem.
const MAX_ITEMS = 5;

@Injectable()
export class SearchHistoryService {
  constructor(private readonly prisma: PrismaService) {}

  async recordSearch(
    identity: SearcherIdentity,
    keyword: string,
  ): Promise<void> {
    assertIdentity(identity);

    // Chỉ trim khoảng trắng thừa — KHÔNG lowercase, giữ nguyên chữ hoa/thường người dùng đã
    // gõ khi hiển thị lại dạng pill. Unique constraint theo đúng chuỗi này nên gõ khác hoa/
    // thường (vd "Áo thun" và "áo thun") vẫn tính là 2 từ khoá riêng — chấp nhận đánh đổi
    // này để đơn giản, không cần thêm cột "keywordNormalized" chỉ cho việc so khớp.
    const trimmed = keyword.trim();
    if (!trimmed) {
      throw new BadRequestException('Từ khoá tìm kiếm không được để trống.');
    }

    if (identity.userId) {
      await this.prisma.searchHistory.upsert({
        where: {
          userId_keyword: { userId: identity.userId, keyword: trimmed },
        },
        update: { searchedAt: new Date() },
        create: { userId: identity.userId, keyword: trimmed },
      });
    } else {
      await this.prisma.searchHistory.upsert({
        where: {
          guestId_keyword: { guestId: identity.guestId!, keyword: trimmed },
        },
        update: { searchedAt: new Date() },
        create: { guestId: identity.guestId!, keyword: trimmed },
      });
    }

    await this.pruneOldEntries(identity);
  }

  async findMyRecentSearches(identity: SearcherIdentity): Promise<string[]> {
    assertIdentity(identity);

    const items = await this.prisma.searchHistory.findMany({
      where: identityWhere(identity),
      orderBy: { searchedAt: 'desc' },
      take: MAX_ITEMS,
      select: { keyword: true },
    });
    return items.map((item) => item.keyword);
  }

  // Giữ tối đa MAX_ITEMS dòng mới nhất cho mỗi định danh — xóa phần dư sau mỗi lần ghi,
  // cùng cách RecentlyViewed đang làm (pruneOldEntries).
  private async pruneOldEntries(identity: SearcherIdentity): Promise<void> {
    const stale = await this.prisma.searchHistory.findMany({
      where: identityWhere(identity),
      orderBy: { searchedAt: 'desc' },
      skip: MAX_ITEMS,
      select: { id: true },
    });
    if (stale.length === 0) return;

    await this.prisma.searchHistory.deleteMany({
      where: { id: { in: stale.map((s) => s.id) } },
    });
  }
}

function assertIdentity(identity: SearcherIdentity): void {
  if (!identity.userId && !identity.guestId) {
    throw new BadRequestException(
      'Thiếu thông tin định danh — cần đăng nhập hoặc gửi header X-Guest-Id.',
    );
  }
}

function identityWhere(identity: SearcherIdentity) {
  return identity.userId
    ? { userId: identity.userId }
    : { guestId: identity.guestId };
}
