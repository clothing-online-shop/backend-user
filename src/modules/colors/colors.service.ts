import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../config/prisma.service';
import { ProductStatus } from '../products/product-status.enum';

@Injectable()
export class ColorsService {
  constructor(private readonly prisma: PrismaService) {}

  // Chỉ trả màu đang có ít nhất 1 biến thể thuộc sản phẩm ACTIVE — dùng cho bộ lọc "Màu" ở
  // trang danh sách sản phẩm (public), cùng lý do với BrandsService.findAllWithProductCount():
  // không hiện màu chưa gắn sản phẩm nào đang bán ra storefront.
  async findAllForStorefront() {
    const colors = await this.prisma.color.findMany({
      where: {
        variants: { some: { product: { status: ProductStatus.ACTIVE } } },
      },
      select: { id: true, name: true, hexCode: true },
      orderBy: { name: 'asc' },
    });

    return colors;
  }
}
