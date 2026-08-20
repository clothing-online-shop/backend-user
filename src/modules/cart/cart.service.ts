import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Cart, CartItem, Product, ProductVariant } from '@prisma/client';
import { PrismaService } from '../../config/prisma.service';
import { ProductStatus } from '../products/product-status.enum';
import { isProductAvailable } from '../../common/utils/product-availability.util';
import { AddCartItemDto } from './dto/add-cart-item.dto';
import { UpdateCartItemDto } from './dto/update-cart-item.dto';
import { MergeCartDto } from './dto/merge-cart.dto';

type CartItemWithVariant = CartItem & {
  productVariant: ProductVariant & { product: Product };
};
type CartWithItems = Cart & { items: CartItemWithVariant[] };

export interface MergeAdjustment {
  productVariantId: string;
  requestedQuantity: number;
  finalQuantity: number;
  reason: 'unavailable' | 'out_of_stock' | 'capped';
}

@Injectable()
export class CartService {
  constructor(private readonly prisma: PrismaService) {}

  async findMyCart(userId: string) {
    const cart = await this.prisma.cart.findFirst({
      where: { userId },
      include: cartInclude,
    });
    if (!cart) {
      return { id: null, items: [], subtotal: 0 };
    }
    return toCartResponse(cart);
  }

  async addItem(userId: string, dto: AddCartItemDto) {
    const variant = await this.fetchActiveVariant(dto.productVariantId);
    const cart = await this.getOrCreateCart(userId);

    const existing = await this.prisma.cartItem.findFirst({
      where: { cartId: cart.id, productVariantId: dto.productVariantId },
    });

    const desiredQty = (existing?.quantity ?? 0) + (dto.quantity ?? 1);
    assertStockAvailable(variant, desiredQty);

    if (existing) {
      await this.prisma.cartItem.update({
        where: { id: existing.id },
        data: { quantity: desiredQty },
      });
    } else {
      await this.prisma.cartItem.create({
        data: {
          cartId: cart.id,
          productVariantId: dto.productVariantId,
          quantity: desiredQty,
        },
      });
    }

    return this.findMyCart(userId);
  }

  async updateItem(userId: string, itemId: string, dto: UpdateCartItemDto) {
    const item = await this.findOwnedItem(userId, itemId);
    assertStockAvailable(item.productVariant, dto.quantity);

    await this.prisma.cartItem.update({
      where: { id: itemId },
      data: { quantity: dto.quantity },
    });

    return this.findMyCart(userId);
  }

  async removeItem(userId: string, itemId: string) {
    await this.findOwnedItem(userId, itemId);
    await this.prisma.cartItem.delete({ where: { id: itemId } });
    return this.findMyCart(userId);
  }

  // Best-effort theo từng dòng — 1 biến thể hết hàng/không còn tồn tại không được làm
  // hỏng cả lần merge (khách vừa đăng nhập, trải nghiệm phải mượt). FE dùng `adjustments`
  // để báo cho khách biết dòng nào bị điều chỉnh/bỏ qua, không bắt buộc phải xử lý.
  async mergeCart(userId: string, dto: MergeCartDto) {
    const cart = await this.getOrCreateCart(userId);
    const adjustments: MergeAdjustment[] = [];

    for (const item of dto.items) {
      const variant = await this.prisma.productVariant.findUnique({
        where: { id: item.productVariantId },
        include: { product: true },
      });

      if (!variant || !isProductAvailable(variant.product)) {
        adjustments.push({
          productVariantId: item.productVariantId,
          requestedQuantity: item.quantity,
          finalQuantity: 0,
          reason: 'unavailable',
        });
        continue;
      }

      const existing = await this.prisma.cartItem.findFirst({
        where: { cartId: cart.id, productVariantId: item.productVariantId },
      });
      const desiredQty = (existing?.quantity ?? 0) + item.quantity;
      const { finalQuantity, reason } = resolveStockOutcome(
        variant.stockQuantity,
        desiredQty,
      );

      if (finalQuantity <= 0) {
        adjustments.push({
          productVariantId: item.productVariantId,
          requestedQuantity: item.quantity,
          finalQuantity: 0,
          reason: 'out_of_stock',
        });
        continue;
      }

      if (existing) {
        await this.prisma.cartItem.update({
          where: { id: existing.id },
          data: { quantity: finalQuantity },
        });
      } else {
        await this.prisma.cartItem.create({
          data: {
            cartId: cart.id,
            productVariantId: item.productVariantId,
            quantity: finalQuantity,
          },
        });
      }

      if (reason === 'capped') {
        adjustments.push({
          productVariantId: item.productVariantId,
          requestedQuantity: item.quantity,
          finalQuantity,
          reason: 'capped',
        });
      }
    }

    return { cart: await this.findMyCart(userId), adjustments };
  }

  // Rà soát toàn bộ giỏ hàng theo tồn kho/tình trạng bán HIỆN TẠI — dùng ngay trước khi
  // vào bước checkout. Dùng chung resolveStockOutcome với mergeCart cho phần so sánh tồn
  // kho (tránh 2 công thức lệch nhau nếu sau này đổi luật), áp dụng cho các dòng ĐÃ CÓ
  // trong giỏ thay vì danh sách merge vào.
  async validateCart(userId: string) {
    const cart = await this.prisma.cart.findFirst({
      where: { userId },
      include: cartInclude,
    });

    const adjustments: MergeAdjustment[] = [];

    for (const item of cart?.items ?? []) {
      if (!isProductAvailable(item.productVariant.product)) {
        // deleteMany (không phải delete) — không throw nếu dòng đã bị request khác xóa/sửa
        // trước đó (2 tab, double-click). Chỉ báo adjustment khi chính request này thật sự
        // xóa được dòng (count > 0) — tránh báo sai cho khách 1 thay đổi mà mình không phải
        // người thực hiện.
        const { count } = await this.prisma.cartItem.deleteMany({
          where: { id: item.id },
        });
        if (count > 0) {
          adjustments.push({
            productVariantId: item.productVariantId,
            requestedQuantity: item.quantity,
            finalQuantity: 0,
            reason: 'unavailable',
          });
        }
        continue;
      }

      const { finalQuantity, reason } = resolveStockOutcome(
        item.productVariant.stockQuantity,
        item.quantity,
      );

      if (reason === 'out_of_stock') {
        const { count } = await this.prisma.cartItem.deleteMany({
          where: { id: item.id },
        });
        if (count > 0) {
          adjustments.push({
            productVariantId: item.productVariantId,
            requestedQuantity: item.quantity,
            finalQuantity: 0,
            reason: 'out_of_stock',
          });
        }
        continue;
      }

      if (reason === 'capped') {
        const { count } = await this.prisma.cartItem.updateMany({
          where: { id: item.id },
          data: { quantity: finalQuantity },
        });
        if (count > 0) {
          adjustments.push({
            productVariantId: item.productVariantId,
            requestedQuantity: item.quantity,
            finalQuantity,
            reason: 'capped',
          });
        }
      }
    }

    return { cart: await this.findMyCart(userId), adjustments };
  }

  private async getOrCreateCart(userId: string): Promise<Cart> {
    const existing = await this.prisma.cart.findFirst({ where: { userId } });
    if (existing) return existing;
    return this.prisma.cart.create({ data: { userId } });
  }

  private async fetchActiveVariant(
    productVariantId: string,
  ): Promise<ProductVariant & { product: Product }> {
    const variant = await this.prisma.productVariant.findUnique({
      where: { id: productVariantId },
      include: { product: true },
    });
    if (!variant) {
      throw new NotFoundException('Không tìm thấy sản phẩm');
    }
    if (!isProductAvailable(variant.product)) {
      throw new BadRequestException('Sản phẩm hiện không khả dụng.');
    }
    return variant;
  }

  // Không dùng NotFoundException chung + kiểm tra userId riêng — trộn 2 bước "tìm" và
  // "có phải của mình không" thành 404 duy nhất để không xác nhận sự tồn tại của dòng
  // giỏ hàng thuộc về user khác.
  private async findOwnedItem(
    userId: string,
    itemId: string,
  ): Promise<CartItemWithVariant> {
    const item = await this.prisma.cartItem.findUnique({
      where: { id: itemId },
      include: { cart: true, productVariant: { include: { product: true } } },
    });
    if (!item || item.cart.userId !== userId) {
      throw new NotFoundException('Không tìm thấy sản phẩm trong giỏ hàng');
    }
    return item;
  }
}

const cartInclude = {
  items: { include: { productVariant: { include: { product: true } } } },
} as const;

// Logic quyết định tồn kho dùng chung giữa mergeCart (số lượng mong muốn = đã có + thêm
// vào) và validateCart (số lượng mong muốn = đang có sẵn trong giỏ) — tránh 2 công thức
// riêng biệt dễ lệch nhau khi đổi luật (trước đây mergeCart dùng Math.min, validateCart
// dùng so sánh trực tiếp, cùng ý nghĩa nhưng viết 2 chỗ).
function resolveStockOutcome(
  stockQuantity: number,
  desiredQuantity: number,
): {
  finalQuantity: number;
  reason: 'out_of_stock' | 'capped' | null;
} {
  if (stockQuantity <= 0) {
    return { finalQuantity: 0, reason: 'out_of_stock' };
  }
  if (stockQuantity < desiredQuantity) {
    return { finalQuantity: stockQuantity, reason: 'capped' };
  }
  return { finalQuantity: desiredQuantity, reason: null };
}

function assertStockAvailable(
  variant: ProductVariant,
  desiredQty: number,
): void {
  if (desiredQty > variant.stockQuantity) {
    throw new BadRequestException(
      `Chỉ còn ${variant.stockQuantity} sản phẩm trong kho.`,
    );
  }
}

function toCartResponse(cart: CartWithItems) {
  const items = cart.items.map((item) => {
    const price = item.productVariant.price.toNumber();
    return {
      id: item.id,
      productVariantId: item.productVariantId,
      quantity: item.quantity,
      price,
      lineTotal: price * item.quantity,
      stockQuantity: item.productVariant.stockQuantity,
      size: item.productVariant.size,
      color: item.productVariant.color,
      product: {
        id: item.productVariant.product.id,
        name: item.productVariant.product.name,
        slug: item.productVariant.product.slug,
        thumbnail: item.productVariant.product.thumbnail,
      },
    };
  });

  return {
    id: cart.id,
    items,
    subtotal: items.reduce((sum, item) => sum + item.lineTotal, 0),
  };
}
