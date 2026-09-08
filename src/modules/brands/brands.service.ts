import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../config/prisma.service';
import { ProductStatus } from '../products/product-status.enum';

@Injectable()
export class BrandsService {
  constructor(private readonly prisma: PrismaService) {}

  // Chỉ trả thương hiệu đang có ít nhất 1 sản phẩm ACTIVE — dùng cho bộ lọc "Thương hiệu" ở
  // trang danh sách sản phẩm, không phải trang quản trị nên không cần thương hiệu rỗng.
  async findAllWithProductCount() {
    const brands = await this.prisma.brand.findMany({
      where: { products: { some: { status: ProductStatus.ACTIVE } } },
      select: {
        id: true,
        name: true,
        _count: {
          select: { products: { where: { status: ProductStatus.ACTIVE } } },
        },
      },
      orderBy: { name: 'asc' },
    });

    return brands.map((brand) => ({
      id: brand.id,
      name: brand.name,
      productCount: brand._count.products,
    }));
  }
}
