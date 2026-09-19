import { Injectable, NotFoundException } from '@nestjs/common';
import { Collection } from '@prisma/client';
import { PrismaService } from '../../config/prisma.service';
import { ProductStatus } from '../products/product-status.enum';

@Injectable()
export class CollectionsService {
  constructor(private readonly prisma: PrismaService) {}

  // "Đang diễn ra" = startDate <= hiện tại <= endDate (không quan tâm cờ riêng, Collection
  // không có isActive — status suy ra hoàn toàn từ ngày, giống cách backend-cms tính RUNNING),
  // cùng cách BannersService.findActive() lọc banner public. Nhiều bộ sưu tập cùng RUNNING
  // thì ưu tiên cái mới bắt đầu nhất — chỉ có 1 vị trí quảng bá ở trang chủ.
  async findActive() {
    const now = new Date();
    const collection = await this.prisma.collection.findFirst({
      where: { isDelete: false, startDate: { lte: now }, endDate: { gte: now } },
      orderBy: { startDate: 'desc' },
    });
    if (!collection) return null;
    return this.toPublicDto(collection);
  }

  async findBySlug(slug: string) {
    const collection = await this.prisma.collection.findFirst({
      where: { slug, isDelete: false },
    });
    if (!collection) {
      throw new NotFoundException('Không tìm thấy bộ sưu tập');
    }
    return this.toPublicDto(collection);
  }

  private async toPublicDto(collection: Collection) {
    // Chỉ đếm sản phẩm còn thật sự hiển thị được ở storefront (chưa xóa mềm, đang mở bán) —
    // khớp điều kiện lọc chính của ProductsService.findAll() khi filter theo collection, để
    // số "N mẫu" hiện ở trang chủ/trang bộ sưu tập luôn khớp với số sản phẩm thực tế duyệt được.
    const productCount = await this.prisma.collectionProduct.count({
      where: {
        collectionId: collection.id,
        product: { isDelete: false, status: ProductStatus.ACTIVE },
      },
    });

    return {
      id: collection.id,
      name: collection.name,
      slug: collection.slug,
      description: collection.description,
      imageUrl: collection.banner,
      productCount,
    };
  }
}
