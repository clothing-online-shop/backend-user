import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { OrdersService } from './orders.service';
import { PrismaService } from '../../config/prisma.service';
import { CartService } from '../cart/cart.service';

function priceDecimal(value: number) {
  return { toNumber: () => value };
}
type DecimalLike = ReturnType<typeof priceDecimal>;

interface OrderCreateArgsForTest {
  totalAmount: number;
  items: {
    create: {
      productVariantId: string;
      quantity: number;
      priceAtPurchase: DecimalLike;
    }[];
  };
}

function cartWithItems() {
  return {
    id: 'cart-1',
    items: [
      {
        id: 'item-1',
        productVariantId: 'variant-1',
        quantity: 2,
        productVariant: {
          id: 'variant-1',
          price: priceDecimal(100000),
          stockQuantity: 5,
          product: { name: 'Áo thun basic' },
        },
      },
    ],
  };
}

function addressRecord() {
  return {
    id: 'addr-1',
    userId: 'user-1',
    receiverName: 'Nguyễn Văn A',
    phone: '0900000000',
    detail: '123 Đường ABC',
    province: { name: 'Hà Nội' },
    district: { name: 'Cầu Giấy' },
    ward: { name: 'Dịch Vọng' },
  };
}

function createMocks() {
  const validateCart = jest
    .fn()
    .mockResolvedValue({ cart: {}, adjustments: [] });
  const cartService = { validateCart } as unknown as CartService;

  const cartFindFirst = jest.fn();
  const addressFindUnique = jest.fn();

  const productVariantUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
  // Mock giả lập đúng shape Prisma trả về thật: totalAmount là Decimal (có .toNumber()),
  // không phải number thô — toOrderResponse() trong orders.service.ts gọi .toNumber() trên
  // field này, mock trả number thô sẽ throw runtime dù lint không bắt được.
  const orderCreate = jest
    .fn()
    .mockImplementation((args: { data: OrderCreateArgsForTest }) =>
      Promise.resolve({
        id: 'order-1',
        ...args.data,
        totalAmount: priceDecimal(args.data.totalAmount),
        items: args.data.items.create,
      }),
    );
  const stockMovementCreateMany = jest.fn().mockResolvedValue({ count: 1 });
  const cartItemDeleteMany = jest.fn().mockResolvedValue({ count: 1 });

  const tx = {
    productVariant: { updateMany: productVariantUpdateMany },
    order: { create: orderCreate },
    stockMovement: { createMany: stockMovementCreateMany },
    cartItem: { deleteMany: cartItemDeleteMany },
  };

  const prisma = {
    cart: { findFirst: cartFindFirst },
    address: { findUnique: addressFindUnique },
    $transaction: jest.fn((fn: (tx: unknown) => unknown) => fn(tx)),
  } as unknown as PrismaService;

  return {
    prisma,
    cartService,
    validateCart,
    cartFindFirst,
    addressFindUnique,
    productVariantUpdateMany,
    orderCreate,
    stockMovementCreateMany,
    cartItemDeleteMany,
  };
}

describe('OrdersService.createOrder', () => {
  it('giỏ hàng rỗng thì báo lỗi, không tạo đơn', async () => {
    const { prisma, cartService, cartFindFirst, orderCreate } = createMocks();
    cartFindFirst.mockResolvedValue({ id: 'cart-1', items: [] });
    const service = new OrdersService(prisma, cartService);

    await expect(
      service.createOrder('user-1', {
        addressId: 'addr-1',
        paymentMethod: 'COD',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(orderCreate).not.toHaveBeenCalled();
  });

  it('địa chỉ không thuộc user thì 404', async () => {
    const { prisma, cartService, cartFindFirst, addressFindUnique } =
      createMocks();
    cartFindFirst.mockResolvedValue(cartWithItems());
    addressFindUnique.mockResolvedValue({
      ...addressRecord(),
      userId: 'someone-else',
    });
    const service = new OrdersService(prisma, cartService);

    await expect(
      service.createOrder('user-1', {
        addressId: 'addr-1',
        paymentMethod: 'COD',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('tạo đơn thành công: trừ đúng tồn kho, ghi sổ kho, xóa giỏ hàng', async () => {
    const {
      prisma,
      cartService,
      cartFindFirst,
      addressFindUnique,
      productVariantUpdateMany,
      orderCreate,
      stockMovementCreateMany,
      cartItemDeleteMany,
    } = createMocks();
    cartFindFirst.mockResolvedValue(cartWithItems());
    addressFindUnique.mockResolvedValue(addressRecord());
    const service = new OrdersService(prisma, cartService);

    const order = await service.createOrder('user-1', {
      addressId: 'addr-1',
      paymentMethod: 'COD',
    });

    expect(productVariantUpdateMany).toHaveBeenCalledWith({
      where: { id: 'variant-1', stockQuantity: { gte: 2 } },
      data: { stockQuantity: { decrement: 2 } },
    });
    expect(orderCreate).toHaveBeenCalledTimes(1);
    expect(stockMovementCreateMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          productVariantId: 'variant-1',
          quantity: -2,
          createdById: null,
        }),
      ],
    });
    expect(cartItemDeleteMany).toHaveBeenCalledWith({
      where: { cartId: 'cart-1' },
    });
    expect(order.totalAmount).toBe(200000);
  });

  it('hết hàng giữa chừng (race) thì báo lỗi, không tạo đơn', async () => {
    const {
      prisma,
      cartService,
      cartFindFirst,
      addressFindUnique,
      productVariantUpdateMany,
      orderCreate,
    } = createMocks();
    cartFindFirst.mockResolvedValue(cartWithItems());
    addressFindUnique.mockResolvedValue(addressRecord());
    productVariantUpdateMany.mockResolvedValue({ count: 0 });
    const service = new OrdersService(prisma, cartService);

    await expect(
      service.createOrder('user-1', {
        addressId: 'addr-1',
        paymentMethod: 'COD',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(orderCreate).not.toHaveBeenCalled();
  });
});
