import { ConflictException, NotFoundException } from '@nestjs/common';
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
      {
        id: 'product-1',
        name: 'Áo thun basic',
        thumbnail: 'thumb.jpg',
        status: ProductStatus.ACTIVE,
        isDelete: false,
      },
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
    // Decimal.toJSON() trả string, không phải number — nếu quên map .toNumber() trước khi
    // trả về, totalAmount sẽ là "300000" (string) thay vì 300000 (number) trên response HTTP,
    // trái với design spec (§4) khai totalAmount: number.
    expect(result.totalAmount).toBe(300000);
    expect(typeof result.totalAmount).toBe('number');
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
    const expectedOrderData: Record<string, unknown> = {
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
    };
    const expectedData = expect.objectContaining(
      expectedOrderData,
    ) as unknown as Record<string, unknown>;
    expect(orderCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expectedData,
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
      where: { OR: [{ id: 'item-1', quantity: 2 }] },
    });
  });

  it('khách đổi số lượng cart item đúng lúc transaction đang chạy (PATCH /cart/items/:id) → deleteMany không khớp quantity cũ, ConflictException, rollback toàn bộ', async () => {
    const {
      prisma,
      mail,
      addressFindUnique,
      cartItemFindMany,
      queryRaw,
      productFindMany,
      orderCreate,
      cartItemDeleteMany,
    } = createMocks();
    addressFindUnique.mockResolvedValue(address());
    // Preflight đọc quantity=2 (chụp tại thời điểm này), toàn bộ itemsData/trừ kho/totalAmount
    // trong transaction đều dùng số lượng này.
    cartItemFindMany.mockResolvedValue([
      cartItem({ id: 'item-1', productVariantId: 'variant-1', quantity: 2 }),
    ]);
    queryRaw.mockResolvedValue([
      lockedRow({ id: 'variant-1', stockQuantity: 10, productId: 'product-1' }),
    ]);
    productFindMany.mockResolvedValue([
      {
        id: 'product-1',
        name: 'Áo thun basic',
        thumbnail: null,
        status: ProductStatus.ACTIVE,
        isDelete: false,
      },
    ]);
    orderCreate.mockResolvedValue({
      id: 'order-1',
      orderCode: 'DH20260820ABC123',
      totalAmount: new Prisma.Decimal(300000),
      items: [],
    });
    // Mô phỏng: đúng lúc transaction đang chạy, khách gọi PATCH /cart/items/item-1 đổi quantity
    // 2 -> 5. Dòng cart item vẫn tồn tại (không bị xoá) nhưng where của deleteMany match cả
    // quantity=2 (giá trị cũ, đã lỗi thời) nên không còn khớp dòng thật (quantity đã là 5) —
    // count trả về 0.
    cartItemDeleteMany.mockResolvedValue({ count: 0 });

    const service = new OrdersService(prisma, mail);

    await expect(service.createOrder('user-1', baseDto())).rejects.toThrow(
      ConflictException,
    );
    expect(cartItemDeleteMany).toHaveBeenCalledWith({
      where: { OR: [{ id: 'item-1', quantity: 2 }] },
    });
    // order.create đã chạy trước bước xoá cart item trong cùng lần thử, nhưng vì toàn bộ nằm
    // trong 1 $transaction callback, throw ở bước xoá cart item khiến Prisma rollback hết.
    expect(orderCreate).toHaveBeenCalledTimes(1);
  });

  it('sản phẩm bị ngừng bán/xoá mềm giữa preflight và transaction → ConflictException trong transaction, không tạo đơn/trừ kho', async () => {
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
    // Preflight (cartItem() mặc định status ACTIVE) pass bình thường.
    cartItemFindMany.mockResolvedValue([
      cartItem({
        id: 'item-1',
        productVariantId: 'variant-1',
        quantity: 2,
        stockQuantity: 10,
      }),
    ]);
    queryRaw.mockResolvedValue([
      lockedRow({ id: 'variant-1', stockQuantity: 10, productId: 'product-1' }),
    ]);
    // Admin ngừng bán sản phẩm đúng lúc giữa preflight và transaction — product.findMany bên
    // trong transaction đọc dữ liệu MỚI, thấy INACTIVE dù preflight (đọc trước đó) đã pass.
    productFindMany.mockResolvedValue([
      {
        id: 'product-1',
        name: 'Áo thun basic',
        thumbnail: null,
        status: ProductStatus.INACTIVE,
        isDelete: false,
      },
    ]);

    const service = new OrdersService(prisma, mail);

    await expect(service.createOrder('user-1', baseDto())).rejects.toThrow(
      ConflictException,
    );
    expect(orderCreate).not.toHaveBeenCalled();
    expect(stockMovementCreate).not.toHaveBeenCalled();
  });

  it('submit trùng đồng thời (double-click/retry): cartItem đã bị 1 transaction khác xoá trước → ConflictException, rollback toàn bộ (không tạo đơn trùng/trừ kho 2 lần)', async () => {
    const {
      prisma,
      mail,
      addressFindUnique,
      cartItemFindMany,
      queryRaw,
      productFindMany,
      orderCreate,
      cartItemDeleteMany,
    } = createMocks();
    addressFindUnique.mockResolvedValue(address());
    cartItemFindMany.mockResolvedValue([
      cartItem({ id: 'item-1', productVariantId: 'variant-1', quantity: 2 }),
    ]);
    // Preflight (ngoài transaction) vẫn thấy cart item còn sống — race xảy ra sau đó, bên
    // trong transaction: 1 request khác với cùng cartItemIds đã commit trước, xoá mất dòng
    // cart item này. lockVariants vẫn thấy đủ tồn kho (giả lập trường hợp tồn kho vẫn đủ sau
    // lần trừ đầu, nên guard duy nhất bắt được race này là deleteMany count).
    queryRaw.mockResolvedValue([
      lockedRow({
        id: 'variant-1',
        stockQuantity: 10,
        price: '150000',
        productId: 'product-1',
      }),
    ]);
    productFindMany.mockResolvedValue([
      {
        id: 'product-1',
        name: 'Áo thun basic',
        thumbnail: 'thumb.jpg',
        status: ProductStatus.ACTIVE,
        isDelete: false,
      },
    ]);
    orderCreate.mockResolvedValue({
      id: 'order-1',
      orderCode: 'DH20260820ABC123',
      totalAmount: new Prisma.Decimal(300000),
      items: [],
    });
    // Mô phỏng phía thua trong race: cart item đã bị request thắng xoá trước, nên deleteMany
    // ở request này không xoá được dòng nào dù dto.cartItemIds có 1 phần tử.
    cartItemDeleteMany.mockResolvedValue({ count: 0 });

    const service = new OrdersService(prisma, mail);

    await expect(service.createOrder('user-1', baseDto())).rejects.toThrow(
      ConflictException,
    );
    // order.create đã chạy trước bước xoá cart item trong cùng lần thử (thứ tự hiện tại của
    // transaction: trừ kho -> tạo Order -> tạo OrderStatusHistory -> xoá cart item) — nhưng vì
    // toàn bộ nằm trong 1 $transaction callback, throw ở bước xoá cart item khiến Prisma
    // rollback hết, nên kết quả cuối cùng createOrder trả về vẫn là lỗi bị throw, không phải
    // Order đã tạo.
    expect(orderCreate).toHaveBeenCalledTimes(1);
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
      {
        id: 'product-1',
        name: 'Áo thun basic',
        thumbnail: null,
        status: ProductStatus.ACTIVE,
        isDelete: false,
      },
    ]);

    const service = new OrdersService(prisma, mail);

    await expect(service.createOrder('user-1', baseDto())).rejects.toThrow(
      ConflictException,
    );
    expect(orderCreate).not.toHaveBeenCalled();
    expect(stockMovementCreate).not.toHaveBeenCalled();
  });

  it('2 dòng CartItem cùng trỏ 1 productVariantId, mỗi dòng riêng lẻ đủ hàng nhưng tổng vượt tồn kho → ConflictException, không trừ kho/tạo đơn', async () => {
    const {
      prisma,
      mail,
      addressFindUnique,
      cartItemFindMany,
      queryRaw,
      productFindMany,
      orderCreate,
      stockMovementCreate,
      productVariantUpdate,
    } = createMocks();
    addressFindUnique.mockResolvedValue(address());
    // Giỏ hàng có 2 dòng cùng trỏ variant-1 (vd do merge giỏ hàng không atomic tạo ra 2 dòng
    // riêng biệt), mỗi dòng quantity=6 — so với stockQuantity trên chính productVariant của
    // từng dòng cart item (10) thì đều "đủ hàng" khi preflight kiểm tra riêng lẻ.
    cartItemFindMany.mockResolvedValue([
      cartItem({
        id: 'item-1',
        productVariantId: 'variant-1',
        quantity: 6,
        stockQuantity: 10,
      }),
      cartItem({
        id: 'item-2',
        productVariantId: 'variant-1',
        quantity: 6,
        stockQuantity: 10,
      }),
    ]);
    // Trong transaction, variant-1 chỉ có 1 dòng bị lock (vì variantIds đã dedup), tồn kho 10.
    // Tổng số lượng yêu cầu thực tế là 6 + 6 = 12 > 10 → phải bị chặn dù mỗi dòng cart item
    // riêng lẻ (6) đều <= 10.
    queryRaw.mockResolvedValue([
      lockedRow({ id: 'variant-1', stockQuantity: 10, productId: 'product-1' }),
    ]);
    productFindMany.mockResolvedValue([
      {
        id: 'product-1',
        name: 'Áo thun basic',
        thumbnail: null,
        status: ProductStatus.ACTIVE,
        isDelete: false,
      },
    ]);

    const service = new OrdersService(prisma, mail);

    await expect(
      service.createOrder(
        'user-1',
        baseDto({ cartItemIds: ['item-1', 'item-2'] }),
      ),
    ).rejects.toThrow(ConflictException);
    expect(stockMovementCreate).not.toHaveBeenCalled();
    expect(productVariantUpdate).not.toHaveBeenCalled();
    expect(orderCreate).not.toHaveBeenCalled();
  });

  it('lockVariants trả về ít dòng hơn variantIds yêu cầu (variant bị xoá giữa preflight và lock) → ConflictException, không phải lỗi hệ thống', async () => {
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
        quantity: 1,
        stockQuantity: 10,
      }),
      cartItem({
        id: 'item-2',
        productVariantId: 'variant-2',
        quantity: 1,
        stockQuantity: 10,
      }),
    ]);
    // variant-2 bị xoá cứng giữa lúc preflight đọc cartItems và lúc FOR UPDATE lock trong
    // transaction — $queryRaw chỉ trả về 1 dòng (variant-1) dù variantIds yêu cầu 2.
    queryRaw.mockResolvedValue([
      lockedRow({ id: 'variant-1', stockQuantity: 10, productId: 'product-1' }),
    ]);
    productFindMany.mockResolvedValue([
      {
        id: 'product-1',
        name: 'Áo thun basic',
        thumbnail: null,
        status: ProductStatus.ACTIVE,
        isDelete: false,
      },
    ]);

    const service = new OrdersService(prisma, mail);

    await expect(
      service.createOrder(
        'user-1',
        baseDto({ cartItemIds: ['item-1', 'item-2'] }),
      ),
    ).rejects.toThrow(ConflictException);
    expect(stockMovementCreate).not.toHaveBeenCalled();
    expect(orderCreate).not.toHaveBeenCalled();
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
      {
        id: 'product-1',
        name: 'Áo thun basic',
        thumbnail: null,
        status: ProductStatus.ACTIVE,
        isDelete: false,
      },
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
      {
        id: 'product-1',
        name: 'Áo thun basic',
        thumbnail: null,
        status: ProductStatus.ACTIVE,
        isDelete: false,
      },
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

  it('paymentMethod = VNPAY → tạo đơn thành công, lưu đúng phương thức đã chọn', async () => {
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
      lockedRow({
        id: 'variant-1',
        stockQuantity: 10,
        price: '150000',
        productId: 'product-1',
      }),
    ]);
    productFindMany.mockResolvedValue([
      {
        id: 'product-1',
        name: 'Áo thun basic',
        thumbnail: null,
        status: ProductStatus.ACTIVE,
        isDelete: false,
      },
    ]);
    orderCreate.mockResolvedValue({
      id: 'order-1',
      orderCode: 'DH20260821XYZ789',
      totalAmount: new Prisma.Decimal(150000),
      items: [],
    });

    const service = new OrdersService(prisma, mail);
    const result = await service.createOrder(
      'user-1',
      baseDto({ paymentMethod: PaymentProvider.VNPAY }),
    );

    expect(result.id).toBe('order-1');
    const expectedData = expect.objectContaining({
      paymentMethod: 'VNPAY',
    }) as unknown as Record<string, unknown>;
    expect(orderCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expectedData,
      }),
    );
  });
});

describe('OrdersService.getOrderByCode', () => {
  function createGetOrderMocks() {
    const orderFindUnique = jest.fn();
    const prisma = {
      order: { findUnique: orderFindUnique },
    } as unknown as PrismaService;
    const mail = {} as unknown as MailService;
    return { prisma, mail, orderFindUnique };
  }

  function orderRow(
    overrides: Partial<{ id: string; userId: string; orderCode: string }> = {},
  ) {
    return {
      id: overrides.id ?? 'order-1',
      userId: overrides.userId ?? 'user-1',
      orderCode: overrides.orderCode ?? 'DH20260821ABCDEF',
      status: 'PENDING',
      totalAmount: new Prisma.Decimal('300000'),
      shippingAddress:
        'Nguyễn Văn A - 0900000000 - 123 Đường ABC, Phường 1, Quận 1, TP. Hồ Chí Minh',
      paymentMethod: PaymentProvider.COD,
      items: [
        {
          id: 'item-1',
          productVariantId: 'variant-1',
          productName: 'Áo thun basic',
          variantSku: 'SKU-1',
          size: 'M',
          color: 'Đen',
          thumbnail: null,
          quantity: 2,
          priceAtPurchase: new Prisma.Decimal('150000'),
        },
      ],
    };
  }

  it('trả đúng đơn khi orderCode tồn tại và thuộc về user', async () => {
    const { prisma, mail, orderFindUnique } = createGetOrderMocks();
    orderFindUnique.mockResolvedValue(orderRow());

    const service = new OrdersService(prisma, mail);
    const result = await service.getOrderByCode('user-1', 'DH20260821ABCDEF');

    expect(orderFindUnique).toHaveBeenCalledWith({
      where: { orderCode: 'DH20260821ABCDEF' },
      include: { items: true },
    });
    expect(result.orderCode).toBe('DH20260821ABCDEF');
    expect(typeof result.totalAmount).toBe('number');
    expect(result.totalAmount).toBe(300000);
    expect(typeof result.items[0].priceAtPurchase).toBe('number');
  });

  it('không tìm thấy orderCode → NotFoundException', async () => {
    const { prisma, mail, orderFindUnique } = createGetOrderMocks();
    orderFindUnique.mockResolvedValue(null);

    const service = new OrdersService(prisma, mail);
    await expect(
      service.getOrderByCode('user-1', 'DH-NOT-EXIST'),
    ).rejects.toThrow(NotFoundException);
  });

  it('orderCode tồn tại nhưng thuộc về user khác → NotFoundException', async () => {
    const { prisma, mail, orderFindUnique } = createGetOrderMocks();
    orderFindUnique.mockResolvedValue(orderRow({ userId: 'user-2' }));

    const service = new OrdersService(prisma, mail);
    await expect(
      service.getOrderByCode('user-1', 'DH20260821ABCDEF'),
    ).rejects.toThrow(NotFoundException);
  });
});

describe('OrdersService.notifyStatusChange', () => {
  function createNotifyMocks() {
    const orderFindUnique = jest.fn();
    const prisma = {
      order: { findUnique: orderFindUnique },
    } as unknown as PrismaService;
    const sendOrderStatusUpdateEmail = jest.fn().mockResolvedValue(undefined);
    const mail = { sendOrderStatusUpdateEmail } as unknown as MailService;
    return { prisma, mail, orderFindUnique, sendOrderStatusUpdateEmail };
  }

  it('order tồn tại → tra đúng email/tên khách theo orderCode rồi gọi MailService', async () => {
    const { prisma, mail, orderFindUnique, sendOrderStatusUpdateEmail } =
      createNotifyMocks();
    orderFindUnique.mockResolvedValue({
      orderCode: 'DH20260821ABCDEF',
      user: { email: 'khach@example.com', fullName: 'Nguyễn Văn A' },
    });
    const service = new OrdersService(prisma, mail);

    await service.notifyStatusChange('DH20260821ABCDEF', 'PACKING', null);

    expect(orderFindUnique).toHaveBeenCalledWith({
      where: { orderCode: 'DH20260821ABCDEF' },
      include: { user: { select: { email: true, fullName: true } } },
    });
    expect(sendOrderStatusUpdateEmail).toHaveBeenCalledWith(
      'khach@example.com',
      {
        orderCode: 'DH20260821ABCDEF',
        customerName: 'Nguyễn Văn A',
        status: 'PACKING',
        note: null,
      },
    );
  });

  it('orderCode không tồn tại → NotFoundException, không gọi MailService', async () => {
    const { prisma, mail, orderFindUnique, sendOrderStatusUpdateEmail } =
      createNotifyMocks();
    orderFindUnique.mockResolvedValue(null);
    const service = new OrdersService(prisma, mail);

    await expect(
      service.notifyStatusChange('DH-NOT-EXIST', 'PACKING', null),
    ).rejects.toThrow(NotFoundException);
    expect(sendOrderStatusUpdateEmail).not.toHaveBeenCalled();
  });

  it('MailService gửi lỗi → không throw ra ngoài (best-effort, chỉ log warn)', async () => {
    const { prisma, mail, orderFindUnique, sendOrderStatusUpdateEmail } =
      createNotifyMocks();
    orderFindUnique.mockResolvedValue({
      orderCode: 'DH20260821ABCDEF',
      user: { email: 'khach@example.com', fullName: 'Nguyễn Văn A' },
    });
    sendOrderStatusUpdateEmail.mockRejectedValue(new Error('SMTP lỗi'));
    const service = new OrdersService(prisma, mail);

    await expect(
      service.notifyStatusChange('DH20260821ABCDEF', 'CANCELLED', 'Khách đổi ý'),
    ).resolves.toBeUndefined();
  });
});
