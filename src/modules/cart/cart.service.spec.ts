import { CartService } from './cart.service';
import { PrismaService } from '../../config/prisma.service';
import { ProductStatus } from '../products/product-status.enum';

function createMocks() {
  const cartFindFirst = jest.fn();
  // Mặc định trả về count: 1 (dòng thật sự bị ảnh hưởng) — test riêng cho trường hợp
  // count: 0 (dòng đã bị request khác xóa/sửa trước đó) tự override lại.
  const cartItemDeleteMany = jest.fn().mockResolvedValue({ count: 1 });
  const cartItemUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
  const prisma = {
    cart: { findFirst: cartFindFirst },
    cartItem: {
      deleteMany: cartItemDeleteMany,
      updateMany: cartItemUpdateMany,
    },
  } as unknown as PrismaService;

  return { prisma, cartFindFirst, cartItemDeleteMany, cartItemUpdateMany };
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
    const { prisma, cartFindFirst, cartItemDeleteMany } = createMocks();
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

    expect(cartItemDeleteMany).toHaveBeenCalledWith({
      where: { id: 'item-1' },
    });
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
    const { prisma, cartFindFirst, cartItemDeleteMany } = createMocks();
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

    expect(cartItemDeleteMany).toHaveBeenCalledWith({
      where: { id: 'item-1' },
    });
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
    const { prisma, cartFindFirst, cartItemUpdateMany } = createMocks();
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

    expect(cartItemUpdateMany).toHaveBeenCalledWith({
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
    const { prisma, cartFindFirst, cartItemDeleteMany, cartItemUpdateMany } =
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

    expect(cartItemDeleteMany).not.toHaveBeenCalled();
    expect(cartItemUpdateMany).not.toHaveBeenCalled();
    expect(result.adjustments).toEqual([]);
  });

  it('xử lý đúng nhiều dòng trong 1 lần gọi: xóa 1, hạ số lượng 1, giữ nguyên 1', async () => {
    const { prisma, cartFindFirst, cartItemDeleteMany, cartItemUpdateMany } =
      createMocks();
    const outOfStockItem = cartItem({
      id: 'item-1',
      productVariantId: 'variant-1',
      quantity: 2,
      stockQuantity: 0,
    });
    const cappedItem = cartItem({
      id: 'item-2',
      productVariantId: 'variant-2',
      quantity: 5,
      stockQuantity: 2,
    });
    const untouchedItem = cartItem({
      id: 'item-3',
      productVariantId: 'variant-3',
      quantity: 1,
      stockQuantity: 10,
    });
    cartFindFirst
      .mockResolvedValueOnce({
        id: 'cart-1',
        items: [outOfStockItem, cappedItem, untouchedItem],
      })
      .mockResolvedValueOnce({
        id: 'cart-1',
        items: [
          cartItem({
            id: 'item-2',
            productVariantId: 'variant-2',
            quantity: 2,
            stockQuantity: 2,
          }),
          untouchedItem,
        ],
      });
    const service = new CartService(prisma);

    const result = await service.validateCart('user-1');

    expect(cartItemDeleteMany).toHaveBeenCalledWith({
      where: { id: 'item-1' },
    });
    expect(cartItemUpdateMany).toHaveBeenCalledWith({
      where: { id: 'item-2' },
      data: { quantity: 2 },
    });
    expect(cartItemDeleteMany).not.toHaveBeenCalledWith({
      where: { id: 'item-3' },
    });
    expect(cartItemUpdateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'item-3' } }),
    );
    expect(result.adjustments).toEqual([
      {
        productVariantId: 'variant-1',
        requestedQuantity: 2,
        finalQuantity: 0,
        reason: 'out_of_stock',
      },
      {
        productVariantId: 'variant-2',
        requestedQuantity: 5,
        finalQuantity: 2,
        reason: 'capped',
      },
    ]);
  });

  it('sản phẩm vừa ngừng bán vừa hết hàng thì ưu tiên reason unavailable (status check trước stock check)', async () => {
    const { prisma, cartFindFirst, cartItemDeleteMany } = createMocks();
    const item = cartItem({
      id: 'item-1',
      productVariantId: 'variant-1',
      quantity: 2,
      stockQuantity: 0,
      status: ProductStatus.INACTIVE,
    });
    cartFindFirst
      .mockResolvedValueOnce({ id: 'cart-1', items: [item] })
      .mockResolvedValueOnce({ id: 'cart-1', items: [] });
    const service = new CartService(prisma);

    const result = await service.validateCart('user-1');

    expect(cartItemDeleteMany).toHaveBeenCalledWith({
      where: { id: 'item-1' },
    });
    expect(result.adjustments).toEqual([
      {
        productVariantId: 'variant-1',
        requestedQuantity: 2,
        finalQuantity: 0,
        reason: 'unavailable',
      },
    ]);
  });

  it('không báo adjustment nếu dòng đã bị request khác xóa/sửa trước đó (count 0)', async () => {
    const { prisma, cartFindFirst, cartItemDeleteMany, cartItemUpdateMany } =
      createMocks();
    // Giả lập race: request khác đã xóa/sửa dòng này trước khi request hiện tại kịp ghi,
    // nên deleteMany/updateMany không ảnh hưởng dòng nào (count: 0).
    cartItemDeleteMany.mockResolvedValue({ count: 0 });
    cartItemUpdateMany.mockResolvedValue({ count: 0 });
    const outOfStockItem = cartItem({
      id: 'item-1',
      productVariantId: 'variant-1',
      quantity: 2,
      stockQuantity: 0,
    });
    const cappedItem = cartItem({
      id: 'item-2',
      productVariantId: 'variant-2',
      quantity: 5,
      stockQuantity: 2,
    });
    cartFindFirst.mockResolvedValue({
      id: 'cart-1',
      items: [outOfStockItem, cappedItem],
    });
    const service = new CartService(prisma);

    const result = await service.validateCart('user-1');

    expect(cartItemDeleteMany).toHaveBeenCalledWith({
      where: { id: 'item-1' },
    });
    expect(cartItemUpdateMany).toHaveBeenCalledWith({
      where: { id: 'item-2' },
      data: { quantity: 2 },
    });
    expect(result.adjustments).toEqual([]);
  });

  it('chỉ rà soát giỏ hàng thuộc về user gọi request (scoping theo userId)', async () => {
    const { prisma, cartFindFirst } = createMocks();
    cartFindFirst.mockResolvedValue(null);
    const service = new CartService(prisma);

    await service.validateCart('user-1');

    expect(cartFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 'user-1' } }),
    );
  });
});
