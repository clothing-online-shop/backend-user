import { Injectable, NotFoundException } from '@nestjs/common';
import { Product, WishlistItem } from '@prisma/client';
import { PrismaService } from '../../config/prisma.service';
import { AVAILABLE_PRODUCT_WHERE } from '../../common/utils/product-availability.util';

type WishlistItemWithProduct = WishlistItem & { product: Product };

@Injectable()
export class WishlistService {
  constructor(private readonly prisma: PrismaService) {}

  async findMyWishlist(userId: string) {
    const items = await this.prisma.wishlistItem.findMany({
      // Ẩn sản phẩm đã xóa mềm/ngừng bán — trang chi tiết của chúng trả 404, để lại trong danh
      // sách yêu thích chỉ cho ra thẻ chết. Dòng WishlistItem vẫn giữ nguyên trong DB (sản phẩm
      // mở bán lại thì hiện lại).
      where: { userId, product: AVAILABLE_PRODUCT_WHERE },
      orderBy: { createdAt: 'desc' },
      include: { product: true },
    });
    return items.map(toWishlistItemResponse);
  }

  // Idempotent — bấm tim 2 lần cùng 1 sản phẩm không báo lỗi trùng, chỉ trả lại dòng đã có
  // (khớp @@unique([userId, productId]) ở schema).
  async addItem(userId: string, productId: string) {
    const product = await this.prisma.product.findUnique({
      where: { id: productId },
    });
    if (!product || product.isDelete) {
      throw new NotFoundException('Không tìm thấy sản phẩm');
    }

    const item = await this.prisma.wishlistItem.upsert({
      where: { userId_productId: { userId, productId } },
      update: {},
      create: { userId, productId },
      include: { product: true },
    });
    return toWishlistItemResponse(item);
  }

  async removeItem(userId: string, productId: string): Promise<void> {
    const { count } = await this.prisma.wishlistItem.deleteMany({
      where: { userId, productId },
    });
    if (count === 0) {
      throw new NotFoundException(
        'Không tìm thấy sản phẩm trong danh sách yêu thích',
      );
    }
  }
}

function toWishlistItemResponse(item: WishlistItemWithProduct) {
  return {
    id: item.id,
    productId: item.productId,
    createdAt: item.createdAt,
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
