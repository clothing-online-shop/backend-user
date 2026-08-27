import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../config/prisma.service';

export interface ActiveFlashSaleProduct {
  id: string;
  name: string;
  slug: string;
  thumbnail: string | null;
  basePrice: number;
  salePrice: number;
  soldPercent: number;
  colors: string[];
}

export interface ActiveFlashSale {
  id: string;
  name: string;
  endDate: Date;
  products: ActiveFlashSaleProduct[];
}

const ACTIVE_ITEM_INCLUDE = {
  productVariant: {
    include: {
      product: {
        select: { id: true, name: true, slug: true, thumbnail: true },
      },
    },
  },
} as const;

@Injectable()
export class FlashSalesService {
  constructor(private readonly prisma: PrismaService) {}

  // Chỉ 1 đợt Flash Sale được hiển thị tại 1 thời điểm — lấy đợt đang RUNNING gần nhất
  // (startDate mới nhất), trả null nếu không có đợt nào đang chạy. Gom item theo sản phẩm
  // (1 sản phẩm có thể có nhiều biến thể/size/màu cùng vào sale) để mỗi sản phẩm chỉ hiện
  // 1 thẻ trên trang chủ — giá đại diện lấy theo biến thể có salePrice thấp nhất, % đã bán
  // tính trên tổng quantityLimit/soldCount của mọi biến thể thuộc sản phẩm đó trong đợt.
  async findActive(): Promise<ActiveFlashSale | null> {
    const now = new Date();
    const flashSale = await this.prisma.flashSale.findFirst({
      where: {
        isDelete: false,
        startDate: { lte: now },
        endDate: { gte: now },
      },
      orderBy: { startDate: 'desc' },
      include: { items: { include: ACTIVE_ITEM_INCLUDE } },
    });
    if (!flashSale) return null;

    const byProduct = new Map<
      string,
      {
        id: string;
        name: string;
        slug: string;
        thumbnail: string | null;
        basePrice: number;
        salePrice: number;
        quantityLimit: number;
        soldCount: number;
        colors: Set<string>;
      }
    >();

    for (const item of flashSale.items) {
      const product = item.productVariant.product;
      const salePrice = item.salePrice.toNumber();
      const existing = byProduct.get(product.id);
      if (!existing) {
        byProduct.set(product.id, {
          id: product.id,
          name: product.name,
          slug: product.slug,
          thumbnail: product.thumbnail,
          basePrice: item.productVariant.price.toNumber(),
          salePrice,
          quantityLimit: item.quantityLimit,
          soldCount: item.soldCount,
          colors: new Set([item.productVariant.color]),
        });
        continue;
      }
      existing.quantityLimit += item.quantityLimit;
      existing.soldCount += item.soldCount;
      existing.colors.add(item.productVariant.color);
      if (salePrice < existing.salePrice) {
        existing.salePrice = salePrice;
        existing.basePrice = item.productVariant.price.toNumber();
      }
    }

    return {
      id: flashSale.id,
      name: flashSale.name,
      endDate: flashSale.endDate,
      products: [...byProduct.values()].map((p) => ({
        id: p.id,
        name: p.name,
        slug: p.slug,
        thumbnail: p.thumbnail,
        basePrice: p.basePrice,
        salePrice: p.salePrice,
        soldPercent:
          p.quantityLimit > 0
            ? Math.round((p.soldCount / p.quantityLimit) * 100)
            : 0,
        colors: [...p.colors],
      })),
    };
  }
}
