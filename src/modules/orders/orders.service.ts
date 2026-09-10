import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  OrderStatus,
  PaymentStatus,
  Prisma,
  StockMovementType,
  Voucher,
} from '@prisma/client';
import { PrismaService } from '../../config/prisma.service';
import { MailService } from '../mail/mail.service';
import { isProductAvailable } from '../../common/utils/product-availability.util';
import { generateOrderCode } from '../../common/utils/order-code.util';
import { resolveOwnedCartItems } from '../../common/utils/cart-items.util';
import { applyStockMovement } from '../../common/utils/stock-movement.util';
import { VouchersService } from '../vouchers/vouchers.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { ListOrdersQueryDto } from './dto/list-orders-query.dto';

const ORDER_CODE_MAX_RETRIES = 3;

type RawVariantRow = {
  id: string;
  stockQuantity: number;
  price: string;
  sku: string;
  size: string;
  color: string;
  productId: string;
};

type OrderWithItems = Prisma.OrderGetPayload<{ include: { items: true } }>;

type LockedVariant = {
  id: string;
  stockQuantity: number;
  price: Prisma.Decimal;
  sku: string;
  size: string;
  color: string;
  productName: string;
  thumbnail: string | null;
  productStatus: number;
  productIsDelete: boolean;
};

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    private readonly vouchers: VouchersService,
  ) {}

  async createOrder(userId: string, dto: CreateOrderDto) {
    const address = await this.prisma.address.findUnique({
      where: { id: dto.addressId },
      include: {
        province: { select: { name: true } },
        district: { select: { name: true } },
        ward: { select: { name: true } },
      },
    });
    if (!address || address.userId !== userId) {
      throw new NotFoundException('Không tìm thấy địa chỉ.');
    }

    const { cartItems, subtotal: preflightSubtotal } =
      await resolveOwnedCartItems(this.prisma, userId, dto.cartItemIds);

    // Preflight ngoài transaction — fail sớm với lỗi rõ ràng trước khi khoá dòng tồn kho,
    // giống preflight isProductAvailable/tồn kho ở trên. Không phải chốt chặn cuối cùng: giá/
    // usedCount có thể đổi giữa đây và lúc vào transaction, nên validateAndCompute() được gọi
    // lại lần nữa bên trong transaction (dùng tx + subtotal tính từ giá đã FOR UPDATE) ngay
    // trước khi redeem() — đó mới là nơi quyết định discountAmount thật sự lưu vào đơn.
    if (dto.voucherCode) {
      await this.vouchers.validateAndCompute(
        this.prisma,
        userId,
        dto.voucherCode,
        preflightSubtotal,
      );
    }

    const shippingAddress = `${address.receiverName} - ${address.phone} - ${address.detail}, ${address.ward.name}, ${address.district.name}, ${address.province.name}`;
    const variantIds = [
      ...new Set(cartItems.map((item) => item.productVariantId)),
    ].sort();

    for (let attempt = 1; attempt <= ORDER_CODE_MAX_RETRIES; attempt++) {
      const orderCode = generateOrderCode();
      try {
        const order = await this.prisma.$transaction(async (tx) => {
          const lockedById = await this.lockVariants(tx, variantIds);

          // Nhiều dòng CartItem có thể trỏ cùng 1 productVariantId (schema không có unique
          // constraint trên (cartId, productVariantId), cart.service.ts merge giỏ hàng theo
          // kiểu findFirst-rồi-create không atomic) — nên phải cộng dồn số lượng theo từng
          // variant rồi mới so với tồn kho, thay vì so từng dòng riêng lẻ với cùng 1 số tồn
          // kho đầy đủ (nếu không, tổng số lượng trừ ở vòng lặp bên dưới có thể vượt tồn kho
          // dù mỗi dòng kiểm tra riêng lẻ đều "hợp lệ").
          const requestedQuantityByVariant = new Map<string, number>();
          for (const item of cartItems) {
            requestedQuantityByVariant.set(
              item.productVariantId,
              (requestedQuantityByVariant.get(item.productVariantId) ?? 0) +
                item.quantity,
            );
          }
          for (const [
            productVariantId,
            totalRequested,
          ] of requestedQuantityByVariant) {
            const variant = this.getLockedVariantOrThrow(
              lockedById,
              productVariantId,
            );
            // isProductAvailable ở preflight chỉ đọc dữ liệu tại thời điểm đó — nếu admin
            // ngừng bán/xoá mềm sản phẩm đúng lúc giữa preflight và transaction này, preflight
            // không bắt được. Re-check ở đây bằng status/isDelete đã lấy kèm lúc lockVariants(),
            // cùng nguồn dữ liệu đáng tin cậy như stockQuantity bên dưới.
            if (
              !isProductAvailable({
                status: variant.productStatus,
                isDelete: variant.productIsDelete,
              })
            ) {
              throw new ConflictException(
                `Sản phẩm "${variant.productName}" hiện không còn khả dụng, vui lòng thử lại.`,
              );
            }
            if (totalRequested > variant.stockQuantity) {
              throw new ConflictException(
                `Sản phẩm "${variant.productName}" vừa hết hàng, vui lòng thử lại.`,
              );
            }
          }

          let totalAmount = new Prisma.Decimal(0);
          const itemsData = cartItems.map((item) => {
            const variant = this.getLockedVariantOrThrow(
              lockedById,
              item.productVariantId,
            );
            totalAmount = totalAmount.add(variant.price.mul(item.quantity));
            return {
              productVariantId: item.productVariantId,
              productName: variant.productName,
              variantSku: variant.sku,
              size: variant.size,
              color: variant.color,
              thumbnail: variant.thumbnail,
              quantity: item.quantity,
              priceAtPurchase: variant.price,
            };
          });

          // Tính lại discountAmount ở đây (không dùng kết quả preflight phía trên) — subtotal
          // dùng ở đây (totalAmount) đến từ giá đã FOR UPDATE, và validateAndCompute() bên
          // trong tx cũng đọc usedCount mới nhất, tránh áp mã dựa trên dữ liệu đã lỗi thời nếu
          // có request khác xen giữa preflight và đây.
          let discountAmount = new Prisma.Decimal(0);
          let voucher: Voucher | null = null;
          if (dto.voucherCode) {
            const result = await this.vouchers.validateAndCompute(
              tx,
              userId,
              dto.voucherCode,
              totalAmount,
            );
            voucher = result.voucher;
            discountAmount = result.discountAmount;
          }

          for (const item of cartItems) {
            await applyStockMovement(tx, {
              productVariantId: item.productVariantId,
              type: StockMovementType.EXPORT,
              quantity: item.quantity,
            });
          }

          const created = await tx.order.create({
            data: {
              userId,
              orderCode,
              status: OrderStatus.PENDING,
              totalAmount: totalAmount.sub(discountAmount),
              discountAmount,
              voucherId: voucher?.id,
              shippingAddress,
              paymentMethod: dto.paymentMethod,
              items: { create: itemsData },
            },
            include: { items: true },
          });

          if (voucher) {
            // Trừ lượt dùng nguyên tử + ghi VoucherRedemption — phải làm SAU khi Order đã có
            // id (redeem() cần orderId để ghi audit), và cùng transaction với toàn bộ phần
            // trên để nếu bước này throw (hết lượt do race), mọi thứ (trừ kho, tạo Order...)
            // đều rollback theo, không để đơn được tạo mà voucher không được ghi nhận đã dùng.
            await this.vouchers.redeem(
              tx,
              voucher,
              userId,
              created.id,
              discountAmount,
            );
          }

          await tx.orderStatusHistory.create({
            data: {
              orderId: created.id,
              fromStatus: null,
              toStatus: OrderStatus.PENDING,
              changedById: null,
            },
          });

          // Kết quả deleteMany dùng làm guard nguyên tử cho chính cart item, thực hiện trong
          // cùng transaction với bước trừ kho ở trên. where khớp cả id LẪN quantity (chụp ở
          // preflight) — không chỉ id — vì itemsData/trừ kho/totalAmount phía trên đều dùng
          // item.quantity từ preflight; nếu khách đổi số lượng (PATCH /cart/items/:id) đúng
          // lúc transaction này đang chạy, dòng cart item vẫn còn tồn tại nhưng quantity đã
          // khác, match theo (id, quantity) sẽ không khớp dòng đó nữa — count < số lượng yêu
          // cầu, coi như 1 dạng thay đổi đồng thời giống hệt case double-click "Đặt hàng"/
          // client tự retry. Throw ngay để rollback toàn bộ transaction (trừ kho, StockMovement,
          // Order, OrderItems, OrderStatusHistory vừa tạo ở trên trong cùng lần thử này), tránh
          // tạo đơn với số lượng/giá đã lỗi thời.
          const deletedCartItems = await tx.cartItem.deleteMany({
            where: {
              OR: cartItems.map((item) => ({
                id: item.id,
                quantity: item.quantity,
              })),
            },
          });
          if (deletedCartItems.count !== dto.cartItemIds.length) {
            throw new ConflictException(
              'Giỏ hàng vừa thay đổi, vui lòng thử lại.',
            );
          }

          return created;
        });

        void this.sendConfirmationEmailBestEffort(userId, order);
        return toOrderResponse(order);
      } catch (err) {
        const isOrderCodeCollision =
          err instanceof Prisma.PrismaClientKnownRequestError &&
          err.code === 'P2002';
        // Lỗi khác (vd ConflictException do hết hàng phát hiện trong transaction) không
        // liên quan gì tới việc trùng mã đơn — thử lại cũng không giải quyết được, rethrow
        // ngay, không tốn thêm lượt retry.
        if (!isOrderCodeCollision) {
          throw err;
        }
        if (attempt === ORDER_CODE_MAX_RETRIES) {
          throw new ConflictException(
            'Không thể tạo mã đơn hàng, vui lòng thử lại sau.',
          );
        }
        // Còn lượt retry — vòng lặp tự sinh orderCode mới ở lần lặp kế tiếp.
      }
    }
    // Không bao giờ tới đây — vòng lặp trên luôn return hoặc throw ở lần thử cuối.
    throw new Error('unreachable');
  }

  // Dùng cho trang cảm ơn/theo dõi đơn — cần đọc lại được bất kỳ lúc nào (refresh, quay
  // lại, mở link đã lưu), không thể chỉ dựa vào response giữ trong state của POST /orders.
  async getOrderByCode(userId: string, orderCode: string) {
    const order = await this.prisma.order.findUnique({
      where: { orderCode },
      include: { items: true },
    });
    // Không tìm thấy HOẶC không thuộc về user hiện tại → gộp chung 1 404, không phân biệt
    // 2 case để tránh lộ thông tin tồn tại của mã đơn người khác — khớp pattern đã dùng
    // trong createOrder() (check địa chỉ/cart item).
    if (!order || order.userId !== userId) {
      throw new NotFoundException('Không tìm thấy đơn hàng.');
    }
    return toOrderResponse(order);
  }

  // Danh sách đơn của user — phân trang, lọc theo nhiều OrderStatus cùng lúc (đã validate ở DTO).
  async listMyOrders(userId: string, query: ListOrdersQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 10;
    const where: Prisma.OrderWhereInput = {
      userId,
      ...(query.status?.length ? { status: { in: query.status } } : {}),
    };

    const [orders, total] = await this.prisma.$transaction([
      this.prisma.order.findMany({
        where,
        include: { items: true },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.order.count({ where }),
    ]);

    return {
      data: orders.map(toOrderResponse),
      meta: {
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
      },
    };
  }

  // Khách tự hủy đơn — chỉ cho phép khi đơn còn PENDING (khác admin bên backend-cms hủy được
  // từ mọi trạng thái). Hoàn kho + hoàn lượt voucher + REFUNDED nếu đã PAID, tất cả trong 1 tx.
  async cancelOrder(userId: string, orderCode: string) {
    const order = await this.prisma.order.findUnique({
      where: { orderCode },
      include: { items: true },
    });
    if (!order || order.userId !== userId) {
      throw new NotFoundException('Không tìm thấy đơn hàng.');
    }
    if (order.status !== OrderStatus.PENDING) {
      throw new ConflictException(
        'Chỉ có thể hủy đơn khi đơn đang ở trạng thái chờ xác nhận.',
      );
    }

    await this.prisma.$transaction(async (tx) => {
      for (const item of order.items) {
        await applyStockMovement(tx, {
          productVariantId: item.productVariantId,
          type: StockMovementType.IMPORT,
          quantity: item.quantity,
        });
      }

      if (order.voucherId) {
        await tx.voucher.update({
          where: { id: order.voucherId },
          data: { usedCount: { decrement: 1 } },
        });
      }

      // where kèm status cũ — optimistic guard: nếu admin đổi trạng thái xen vào giữa, count = 0
      // → throw → rollback cả phần hoàn kho/voucher vừa ghi, không hủy đè lên trạng thái mới.
      const updated = await tx.order.updateMany({
        where: { id: order.id, status: OrderStatus.PENDING },
        data: {
          status: OrderStatus.CANCELLED,
          ...(order.paymentStatus === PaymentStatus.PAID
            ? { paymentStatus: PaymentStatus.REFUNDED }
            : {}),
        },
      });
      if (updated.count === 0) {
        throw new ConflictException(
          'Đơn hàng vừa được cập nhật, vui lòng thử lại.',
        );
      }

      await tx.orderStatusHistory.create({
        data: {
          orderId: order.id,
          fromStatus: OrderStatus.PENDING,
          toStatus: OrderStatus.CANCELLED,
          note: 'Khách hàng tự hủy đơn',
          changedById: userId,
        },
      });
    });

    return this.getOrderByCode(userId, orderCode);
  }

  // SELECT ... FOR UPDATE khoá các dòng ProductVariant liên quan, sắp theo id tăng dần
  // (variantIds đã được sort trước khi gọi) — đảm bảo 2 đơn hàng chứa chung sản phẩm luôn
  // lock theo cùng 1 thứ tự, tránh deadlock. Cùng lý do đã áp dụng cho lockVariant() ở
  // backend-cms/src/modules/inventory/inventory.service.ts, chỉ khác là lock nhiều dòng
  // 1 lúc thay vì 1 dòng.
  private async lockVariants(
    tx: Prisma.TransactionClient,
    variantIds: string[],
  ): Promise<Map<string, LockedVariant>> {
    const rows = await tx.$queryRaw<RawVariantRow[]>(Prisma.sql`
      SELECT id, "stockQuantity", price, sku, size, color, "productId"
      FROM "product_variants"
      WHERE id = ANY(${variantIds})
      ORDER BY id
      FOR UPDATE
    `);

    const products = await tx.product.findMany({
      where: { id: { in: [...new Set(rows.map((row) => row.productId))] } },
      select: {
        id: true,
        name: true,
        thumbnail: true,
        status: true,
        isDelete: true,
      },
    });
    const productById = new Map(products.map((p) => [p.id, p]));

    const result = new Map<string, LockedVariant>();
    for (const row of rows) {
      // Sản phẩm có thể bị xoá cứng giữa lúc truy vấn rows ở trên và findMany này (dù cửa sổ
      // rất hẹp vì cùng trong 1 transaction) — không dùng "!" để bypass, throw lỗi rõ ràng
      // thay vì để TypeError không kiểm soát lọt ra ngoài thành lỗi 500.
      const product = productById.get(row.productId);
      if (!product) {
        throw new ConflictException(
          'Một số sản phẩm không còn tồn tại, vui lòng thử lại.',
        );
      }
      result.set(row.id, {
        id: row.id,
        stockQuantity: row.stockQuantity,
        price: new Prisma.Decimal(row.price),
        sku: row.sku,
        size: row.size,
        color: row.color,
        productName: product.name,
        thumbnail: product.thumbnail,
        productStatus: product.status,
        productIsDelete: product.isDelete,
      });
    }
    return result;
  }

  // Nếu 1 ProductVariant bị xoá cứng giữa lúc preflight đọc dữ liệu (dòng cartItems ở trên)
  // và lúc lockVariants() lock hàng bằng FOR UPDATE, lockedById sẽ thiếu entry cho
  // productVariantId đó. Guard tại đây thay vì dùng "!" để trả về ConflictException nhất
  // quán với các lỗi race condition khác trong hàm này, thay vì để TypeError lọt ra thành
  // lỗi 500 không kiểm soát.
  private getLockedVariantOrThrow(
    lockedById: Map<string, LockedVariant>,
    productVariantId: string,
  ): LockedVariant {
    const variant = lockedById.get(productVariantId);
    if (!variant) {
      throw new ConflictException(
        'Một số sản phẩm không còn tồn tại, vui lòng thử lại.',
      );
    }
    return variant;
  }

  // Gọi bởi backend-cms qua POST /internal/orders/:orderCode/status-notification mỗi lần
  // admin đổi trạng thái đơn — tự tra email/tên khách theo orderCode (không nhận trực tiếp
  // từ backend-cms) để tránh phụ thuộc caller cung cấp đúng địa chỉ gửi, xem spec
  // docs/superpowers/specs/2026-08-22-order-status-flow-email-notification-design.md
  // (backend-cms). NotFoundException nếu orderCode sai — đây là lỗi thật cần biết (khác gửi
  // mail thất bại, chỉ log warn best-effort như sendConfirmationEmailBestEffort bên dưới).
  async notifyStatusChange(
    orderCode: string,
    status: OrderStatus,
    note: string | null,
  ): Promise<void> {
    const order = await this.prisma.order.findUnique({
      where: { orderCode },
      include: { user: { select: { email: true, fullName: true } } },
    });
    if (!order) {
      throw new NotFoundException('Không tìm thấy đơn hàng.');
    }

    try {
      await this.mail.sendOrderStatusUpdateEmail(order.user.email, {
        orderCode: order.orderCode,
        customerName: order.user.fullName,
        status,
        note,
      });
    } catch (err) {
      this.logger.warn(
        `Không gửi được email báo trạng thái đơn ${orderCode}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  // Best-effort — gửi mail xác nhận không phải điều kiện để coi đơn hàng đã tạo thành
  // công. Không await ở call site (createOrder) để không làm chậm response chờ SMTP.
  private async sendConfirmationEmailBestEffort(
    userId: string,
    order: OrderWithItems,
  ): Promise<void> {
    try {
      const user = await this.prisma.user.findUniqueOrThrow({
        where: { id: userId },
        select: { email: true },
      });
      await this.mail.sendOrderConfirmationEmail(user.email, {
        orderCode: order.orderCode,
        totalAmount: order.totalAmount.toNumber(),
        shippingAddress: order.shippingAddress,
        paymentMethod: order.paymentMethod,
        items: order.items.map((item) => ({
          productName: item.productName,
          size: item.size,
          color: item.color,
          quantity: item.quantity,
          priceAtPurchase: item.priceAtPurchase.toNumber(),
        })),
      });
    } catch (err) {
      this.logger.warn(
        `Không gửi được email xác nhận đơn hàng ${order.orderCode}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}

// Prisma.Decimal.toJSON() trả về string (vd "300000"), không phải number — nếu để nguyên
// Order/OrderItem thô ra response, totalAmount/priceAtPurchase sẽ serialize thành string
// qua HTTP dù design spec khai number. Map sang .toNumber() ở đúng ranh giới trả về response,
// giống toListItem/toVariantDto trong products.service.ts — phần tính toán tiền bên trong
// transaction vẫn dùng Prisma.Decimal nguyên vẹn, không đụng tới.
function toOrderResponse(order: OrderWithItems) {
  return {
    ...order,
    totalAmount: order.totalAmount.toNumber(),
    discountAmount: order.discountAmount.toNumber(),
    items: order.items.map((item) => ({
      ...item,
      priceAtPurchase: item.priceAtPurchase.toNumber(),
    })),
  };
}
