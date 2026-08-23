import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../config/prisma.service';
import { isProductAvailable } from './product-availability.util';

export type OwnedCartItem = Prisma.CartItemGetPayload<{
  include: { cart: true; productVariant: { include: { product: true } } };
}>;

// Dùng chung giữa OrdersService (checkout thật) và VouchersService (preview /vouchers/validate)
// — cả 2 đều cần đọc đúng các dòng cart item thuộc về user, còn khả dụng/đủ tồn kho, và cùng
// 1 cách tính subtotal ước tính (giá đọc không khoá — số cuối cùng dùng để trừ kho/lưu đơn vẫn
// tính lại trong transaction ở OrdersService.createOrder bằng giá đã FOR UPDATE, xem comment ở
// đó). Trước đây logic này chỉ nằm trong OrdersService, copy lại ở đây là sai theo CLAUDE.md.
export async function resolveOwnedCartItems(
  prisma: PrismaService | Prisma.TransactionClient,
  userId: string,
  cartItemIds: string[],
): Promise<{ cartItems: OwnedCartItem[]; subtotal: Prisma.Decimal }> {
  const cartItems = await prisma.cartItem.findMany({
    where: { id: { in: cartItemIds } },
    include: {
      cart: true,
      productVariant: { include: { product: true } },
    },
  });
  if (
    cartItems.length !== cartItemIds.length ||
    cartItems.some((item) => item.cart.userId !== userId)
  ) {
    throw new NotFoundException('Không tìm thấy sản phẩm trong giỏ hàng.');
  }

  const unavailable = cartItems.filter(
    (item) =>
      !isProductAvailable(item.productVariant.product) ||
      item.quantity > item.productVariant.stockQuantity,
  );
  if (unavailable.length > 0) {
    const names = unavailable.map((item) => item.productVariant.product.name);
    throw new BadRequestException(
      `Sản phẩm không khả dụng hoặc không đủ hàng: ${names.join(', ')}.`,
    );
  }

  const subtotal = cartItems.reduce(
    (sum, item) => sum.add(item.productVariant.price.mul(item.quantity)),
    new Prisma.Decimal(0),
  );
  return { cartItems, subtotal };
}
