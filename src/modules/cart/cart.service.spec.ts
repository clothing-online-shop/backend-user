import { CartService } from './cart.service';
import { PrismaService } from '../../config/prisma.service';
import { ProductStatus } from '../products/product-status.enum';

function createMocks() {
  const cartFindFirst = jest.fn();
  const cartItemDelete = jest.fn();
  const cartItemUpdate = jest.fn();
  const prisma = {
    cart: { findFirst: cartFindFirst },
    cartItem: { delete: cartItemDelete, update: cartItemUpdate },
  } as unknown as PrismaService;

  return { prisma, cartFindFirst, cartItemDelete, cartItemUpdate };
}

function cartItem(overrides: {
  id: string;
  productVariantId: string;
  quantity: number;
  stockQuantity: number;
  status?: ProductStatus;
}) {
  return {
    id: overrides.id,
    cartId: 'cart-1',
    productVariantId: overrides.productVariantId,
    quantity: overrides.quantity,
    productVariant: {
      id: overrides.productVariantId,
      price: { toNumber: () => 100000 },
      stockQuantity: overrides.stockQuantity,
      size: 'M',
      color: 'Đen',
      product: {
        id: 'product-1',
        name: 'Áo thun basic',
        slug: 'ao-thun-basic',
        thumbnail: null,
        status: overrides.status ?? ProductStatus.ACTIVE,
      },
    },
  };
}

describe('CartService.validateCart', () => {
  it('trả về giỏ trống, không có adjustment nếu user chưa có giỏ hàng', async () => {
    const { prisma, cartFindFirst } = createMocks();
    cartFindFirst.mockResolvedValue(null);
    const service = new CartService(prisma);

    const result = await service.validateCart('user-1');

    expect(result).toEqual({
      cart: { id: null, items: [], subtotal: 0 },
      adjustments: [],
    });
  });

  it('xóa dòng có sản phẩm ngừng bán (reason unavailable)', async () => {
    const { prisma, cartFindFirst, cartItemDelete } = createMocks();
    const item = cartItem({
      id: 'item-1',
      productVariantId: 'variant-1',
      quantity: 2,
      stockQuantity: 5,
      status: ProductStatus.INACTIVE,
    });
    cartFindFirst
      .mockResolvedValueOnce({ id: 'cart-1', items: [item] })
      .mockResolvedValueOnce({ id: 'cart-1', items: [] });
    const service = new CartService(prisma);

    const result = await service.validateCart('user-1');

    expect(cartItemDelete).toHaveBeenCalledWith({ where: { id: 'item-1' } });
    expect(result.adjustments).toEqual([
      {
        productVariantId: 'variant-1',
        requestedQuantity: 2,
        finalQuantity: 0,
        reason: 'unavailable',
      },
    ]);
  });

  it('xóa dòng hết hàng hẳn (reason out_of_stock)', async () => {
    const { prisma, cartFindFirst, cartItemDelete } = createMocks();
    const item = cartItem({
      id: 'item-1',
      productVariantId: 'variant-1',
      quantity: 2,
      stockQuantity: 0,
    });
    cartFindFirst
      .mockResolvedValueOnce({ id: 'cart-1', items: [item] })
      .mockResolvedValueOnce({ id: 'cart-1', items: [] });
    const service = new CartService(prisma);

    const result = await service.validateCart('user-1');

    expect(cartItemDelete).toHaveBeenCalledWith({ where: { id: 'item-1' } });
    expect(result.adjustments).toEqual([
      {
        productVariantId: 'variant-1',
        requestedQuantity: 2,
        finalQuantity: 0,
        reason: 'out_of_stock',
      },
    ]);
  });

  it('hạ số lượng dòng còn hàng nhưng không đủ (reason capped)', async () => {
    const { prisma, cartFindFirst, cartItemUpdate } = createMocks();
    const item = cartItem({
      id: 'item-1',
      productVariantId: 'variant-1',
      quantity: 5,
      stockQuantity: 2,
    });
    const itemAfter = cartItem({
      id: 'item-1',
      productVariantId: 'variant-1',
      quantity: 2,
      stockQuantity: 2,
    });
    cartFindFirst
      .mockResolvedValueOnce({ id: 'cart-1', items: [item] })
      .mockResolvedValueOnce({ id: 'cart-1', items: [itemAfter] });
    const service = new CartService(prisma);

    const result = await service.validateCart('user-1');

    expect(cartItemUpdate).toHaveBeenCalledWith({
      where: { id: 'item-1' },
      data: { quantity: 2 },
    });
    expect(result.adjustments).toEqual([
      {
        productVariantId: 'variant-1',
        requestedQuantity: 5,
        finalQuantity: 2,
        reason: 'capped',
      },
    ]);
    expect(result.cart.items[0].quantity).toBe(2);
  });

  it('giữ nguyên dòng còn đủ hàng, không có adjustment nào', async () => {
    const { prisma, cartFindFirst, cartItemDelete, cartItemUpdate } =
      createMocks();
    const item = cartItem({
      id: 'item-1',
      productVariantId: 'variant-1',
      quantity: 2,
      stockQuantity: 5,
    });
    cartFindFirst.mockResolvedValue({ id: 'cart-1', items: [item] });
    const service = new CartService(prisma);

    const result = await service.validateCart('user-1');

    expect(cartItemDelete).not.toHaveBeenCalled();
    expect(cartItemUpdate).not.toHaveBeenCalled();
    expect(result.adjustments).toEqual([]);
  });
});
