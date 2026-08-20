import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { PaymentProvider, Prisma } from '@prisma/client';
import { OrdersService } from './orders.service';
import { PrismaService } from '../../config/prisma.service';
import { MailService } from '../mail/mail.service';
import { ProductStatus } from '../products/product-status.enum';
import { CreateOrderDto } from './dto/create-order.dto';

function createMocks() {
  const addressFindUnique = jest.fn();
  const cartItemFindMany = jest.fn();
  const userFindUniqueOrThrow = jest
    .fn()
    .mockResolvedValue({ email: 'user@example.com' });

  const queryRaw = jest.fn();
  const productFindMany = jest.fn();
  const stockMovementCreate = jest.fn().mockResolvedValue({});
  const productVariantUpdate = jest.fn().mockResolvedValue({});
  const orderCreate = jest.fn();
  const orderStatusHistoryCreate = jest.fn().mockResolvedValue({});
  const cartItemDeleteMany = jest.fn().mockResolvedValue({ count: 1 });

  const tx = {
    $queryRaw: queryRaw,
    product: { findMany: productFindMany },
    stockMovement: { create: stockMovementCreate },
    productVariant: { update: productVariantUpdate },
    order: { create: orderCreate },
    orderStatusHistory: { create: orderStatusHistoryCreate },
    cartItem: { deleteMany: cartItemDeleteMany },
  };

  const transaction = jest.fn((cb: (tx: unknown) => unknown) => cb(tx));

  const prisma = {
    address: { findUnique: addressFindUnique },
    cartItem: { findMany: cartItemFindMany },
    user: { findUniqueOrThrow: userFindUniqueOrThrow },
    $transaction: transaction,
  } as unknown as PrismaService;

  const sendOrderConfirmationEmail = jest.fn().mockResolvedValue(undefined);
  const mail = { sendOrderConfirmationEmail } as unknown as MailService;

  return {
    prisma,
    mail,
    tx,
    addressFindUnique,
    cartItemFindMany,
    userFindUniqueOrThrow,
    queryRaw,
    productFindMany,
    stockMovementCreate,
    productVariantUpdate,
    orderCreate,
    orderStatusHistoryCreate,
    cartItemDeleteMany,
    transaction,
    sendOrderConfirmationEmail,
  };
}

function address(overrides: Partial<{ id: string; userId: string }> = {}) {
  return {
    id: overrides.id ?? 'address-1',
    userId: overrides.userId ?? 'user-1',
    receiverName: 'Nguyễn Văn A',
    phone: '0900000000',
    detail: '123 Đường ABC',
    ward: { name: 'Phường 1' },
    district: { name: 'Quận 1' },
    province: { name: 'TP. Hồ Chí Minh' },
  };
}

function cartItem(overrides: {
  id: string;
  productVariantId: string;
  quantity: number;
  cartUserId?: string;
  status?: ProductStatus;
  stockQuantity?: number;
}) {
  return {
    id: overrides.id,
    productVariantId: overrides.productVariantId,
    quantity: overrides.quantity,
    cart: { userId: overrides.cartUserId ?? 'user-1' },
    productVariant: {
      id: overrides.productVariantId,
      stockQuantity: overrides.stockQuantity ?? 10,
      product: {
        name: 'Áo thun basic',
        status: overrides.status ?? ProductStatus.ACTIVE,
        isDelete: false,
      },
    },
  };
}

function lockedRow(overrides: {
  id: string;
  stockQuantity: number;
  price?: string;
  productId?: string;
}) {
  return {
    id: overrides.id,
    stockQuantity: overrides.stockQuantity,
    price: overrides.price ?? '150000',
    sku: `SKU-${overrides.id}`,
    size: 'M',
    color: 'Đen',
    productId: overrides.productId ?? `product-${overrides.id}`,
  };
}

function baseDto(overrides: Partial<CreateOrderDto> = {}): CreateOrderDto {
  return {
    addressId: 'address-1',
    cartItemIds: ['item-1'],
    paymentMethod: PaymentProvider.COD,
    ...overrides,
  };
}

describe('OrdersService.createOrder', () => {
  it('tạo đơn thành công: snapshot đúng, trừ kho, ghi StockMovement + OrderStatusHistory, xoá cart item', async () => {
    const {
      prisma,
      mail,
      addressFindUnique,
      cartItemFindMany,
      queryRaw,
      productFindMany,
      stockMovementCreate,
      productVariantUpdate,
      orderCreate,
      orderStatusHistoryCreate,
      cartItemDeleteMany,
    } = createMocks();

    addressFindUnique.mockResolvedValue(address());
    cartItemFindMany.mockResolvedValue([
      cartItem({ id: 'item-1', productVariantId: 'variant-1', quantity: 2 }),
    ]);
    queryRaw.mockResolvedValue([
      lockedRow({
        id: 'variant-1',
        stockQuantity: 10,
        price: '150000',
        productId: 'product-1',
      }),
    ]);
    productFindMany.mockResolvedValue([
      { id: 'product-1', name: 'Áo thun basic', thumbnail: 'thumb.jpg' },
    ]);
    orderCreate.mockResolvedValue({
      id: 'order-1',
      orderCode: 'DH20260820ABC123',
      totalAmount: new Prisma.Decimal(300000),
      items: [],
    });

    const service = new OrdersService(prisma, mail);
    const result = await service.createOrder('user-1', baseDto());

    expect(result.id).toBe('order-1');
    expect(stockMovementCreate).toHaveBeenCalledWith({
      data: {
        productVariantId: 'variant-1',
        type: 'EXPORT',
        quantity: -2,
        createdById: null,
      },
    });
    expect(productVariantUpdate).toHaveBeenCalledWith({
      where: { id: 'variant-1' },
      data: { stockQuantity: { decrement: 2 } },
    });
    expect(orderCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: 'user-1',
          status: 'PENDING',
          paymentMethod: 'COD',
          items: {
            create: [
              expect.objectContaining({
                productVariantId: 'variant-1',
                productName: 'Áo thun basic',
                variantSku: 'SKU-variant-1',
                size: 'M',
                color: 'Đen',
                thumbnail: 'thumb.jpg',
                quantity: 2,
              }),
            ],
          },
        }),
      }),
    );
    expect(orderStatusHistoryCreate).toHaveBeenCalledWith({
      data: {
        orderId: 'order-1',
        fromStatus: null,
        toStatus: 'PENDING',
        changedById: null,
      },
    });
    expect(cartItemDeleteMany).toHaveBeenCalledWith({
      where: { id: { in: ['item-1'] } },
    });
  });

  it('địa chỉ không thuộc về user → NotFoundException', async () => {
    const { prisma, mail, addressFindUnique } = createMocks();
    addressFindUnique.mockResolvedValue(address({ userId: 'other-user' }));

    const service = new OrdersService(prisma, mail);

    await expect(service.createOrder('user-1', baseDto())).rejects.toThrow(
      NotFoundException,
    );
  });

  it('addressId không tồn tại → NotFoundException', async () => {
    const { prisma, mail, addressFindUnique } = createMocks();
    addressFindUnique.mockResolvedValue(null);

    const service = new OrdersService(prisma, mail);

    await expect(service.createOrder('user-1', baseDto())).rejects.toThrow(
      NotFoundException,
    );
  });

  it('cartItemIds chứa dòng không thuộc giỏ hàng của user → NotFoundException', async () => {
    const { prisma, mail, addressFindUnique, cartItemFindMany } = createMocks();
    addressFindUnique.mockResolvedValue(address());
    cartItemFindMany.mockResolvedValue([
      cartItem({
        id: 'item-1',
        productVariantId: 'variant-1',
        quantity: 2,
        cartUserId: 'other-user',
      }),
    ]);

    const service = new OrdersService(prisma, mail);

    await expect(service.createOrder('user-1', baseDto())).rejects.toThrow(
      NotFoundException,
    );
  });

  it('cartItemIds chứa id không tồn tại (giỏ hàng trả về ít hơn số id gửi lên) → NotFoundException', async () => {
    const { prisma, mail, addressFindUnique, cartItemFindMany } = createMocks();
    addressFindUnique.mockResolvedValue(address());
    cartItemFindMany.mockResolvedValue([]);

    const service = new OrdersService(prisma, mail);

    await expect(service.createOrder('user-1', baseDto())).rejects.toThrow(
      NotFoundException,
    );
  });

  it('sản phẩm ngừng bán hoặc không đủ hàng ở bước preflight → BadRequestException liệt kê đúng tên sản phẩm', async () => {
    const { prisma, mail, addressFindUnique, cartItemFindMany } = createMocks();
    addressFindUnique.mockResolvedValue(address());
    cartItemFindMany.mockResolvedValue([
      cartItem({
        id: 'item-1',
        productVariantId: 'variant-1',
        quantity: 2,
        status: ProductStatus.INACTIVE,
      }),
      cartItem({
        id: 'item-2',
        productVariantId: 'variant-2',
        quantity: 20,
        stockQuantity: 5,
      }),
    ]);

    const service = new OrdersService(prisma, mail);

    await expect(
      service.createOrder(
        'user-1',
        baseDto({ cartItemIds: ['item-1', 'item-2'] }),
      ),
    ).rejects.toThrow(
      'Sản phẩm không khả dụng hoặc không đủ hàng: Áo thun basic, Áo thun basic.',
    );
  });

  it('hết hàng phát hiện trong transaction (race condition) → ConflictException, không tạo đơn/trừ kho', async () => {
    const {
      prisma,
      mail,
      addressFindUnique,
      cartItemFindMany,
      queryRaw,
      productFindMany,
      orderCreate,
      stockMovementCreate,
    } = createMocks();
    addressFindUnique.mockResolvedValue(address());
    cartItemFindMany.mockResolvedValue([
      cartItem({
        id: 'item-1',
        productVariantId: 'variant-1',
        quantity: 2,
        stockQuantity: 10,
      }),
    ]);
    // Preflight thấy đủ hàng (10 >= 2), nhưng lúc lock trong transaction thì đã có đơn khác
    // mua trước, chỉ còn 1.
    queryRaw.mockResolvedValue([
      lockedRow({ id: 'variant-1', stockQuantity: 1, productId: 'product-1' }),
    ]);
    productFindMany.mockResolvedValue([
      { id: 'product-1', name: 'Áo thun basic', thumbnail: null },
    ]);

    const service = new OrdersService(prisma, mail);

    await expect(service.createOrder('user-1', baseDto())).rejects.toThrow(
      ConflictException,
    );
    expect(orderCreate).not.toHaveBeenCalled();
    expect(stockMovementCreate).not.toHaveBeenCalled();
  });

  it('trùng orderCode ở lần thử đầu → tự retry và tạo đơn thành công ở lần thử thứ 2', async () => {
    const {
      prisma,
      mail,
      addressFindUnique,
      cartItemFindMany,
      queryRaw,
      productFindMany,
      orderCreate,
    } = createMocks();
    addressFindUnique.mockResolvedValue(address());
    cartItemFindMany.mockResolvedValue([
      cartItem({ id: 'item-1', productVariantId: 'variant-1', quantity: 1 }),
    ]);
    queryRaw.mockResolvedValue([
      lockedRow({ id: 'variant-1', stockQuantity: 10, productId: 'product-1' }),
    ]);
    productFindMany.mockResolvedValue([
      { id: 'product-1', name: 'Áo thun basic', thumbnail: null },
    ]);
    const collisionError = new Prisma.PrismaClientKnownRequestError('unique', {
      code: 'P2002',
      clientVersion: '6.19.3',
    });
    orderCreate.mockRejectedValueOnce(collisionError).mockResolvedValueOnce({
      id: 'order-1',
      orderCode: 'DH20260820XYZ999',
      totalAmount: new Prisma.Decimal(150000),
      items: [],
    });

    const service = new OrdersService(prisma, mail);
    const result = await service.createOrder('user-1', baseDto());

    expect(result.id).toBe('order-1');
    expect(orderCreate).toHaveBeenCalledTimes(2);
  });

  it('trùng orderCode cả 3 lần thử → ConflictException, không tạo đơn', async () => {
    const {
      prisma,
      mail,
      addressFindUnique,
      cartItemFindMany,
      queryRaw,
      productFindMany,
      orderCreate,
    } = createMocks();
    addressFindUnique.mockResolvedValue(address());
    cartItemFindMany.mockResolvedValue([
      cartItem({ id: 'item-1', productVariantId: 'variant-1', quantity: 1 }),
    ]);
    queryRaw.mockResolvedValue([
      lockedRow({ id: 'variant-1', stockQuantity: 10, productId: 'product-1' }),
    ]);
    productFindMany.mockResolvedValue([
      { id: 'product-1', name: 'Áo thun basic', thumbnail: null },
    ]);
    const collisionError = new Prisma.PrismaClientKnownRequestError('unique', {
      code: 'P2002',
      clientVersion: '6.19.3',
    });
    orderCreate.mockRejectedValue(collisionError);

    const service = new OrdersService(prisma, mail);

    await expect(service.createOrder('user-1', baseDto())).rejects.toThrow(
      ConflictException,
    );
    expect(orderCreate).toHaveBeenCalledTimes(3);
  });

  it('paymentMethod khác COD → BadRequestException, không gọi Prisma', async () => {
    const { prisma, mail, addressFindUnique } = createMocks();

    const service = new OrdersService(prisma, mail);

    await expect(
      service.createOrder(
        'user-1',
        baseDto({ paymentMethod: PaymentProvider.VNPAY }),
      ),
    ).rejects.toThrow(BadRequestException);
    expect(addressFindUnique).not.toHaveBeenCalled();
  });
});
