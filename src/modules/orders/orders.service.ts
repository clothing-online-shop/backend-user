import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  OrderStatus,
  PaymentProvider,
  Prisma,
  StockMovementType,
} from '@prisma/client';
import { PrismaService } from '../../config/prisma.service';
import { MailService } from '../mail/mail.service';
import { isProductAvailable } from '../../common/utils/product-availability.util';
import { generateOrderCode } from '../../common/utils/order-code.util';
import { CreateOrderDto } from './dto/create-order.dto';

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

type LockedVariant = {
  id: string;
  stockQuantity: number;
  price: Prisma.Decimal;
  sku: string;
  size: string;
  color: string;
  productName: string;
  thumbnail: string | null;
};

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
  ) {}

  async createOrder(userId: string, dto: CreateOrderDto) {
    if (dto.paymentMethod !== PaymentProvider.COD) {
      throw new BadRequestException(
        'Hiện chỉ hỗ trợ thanh toán khi nhận hàng (COD).',
      );
    }

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

    const cartItems = await this.prisma.cartItem.findMany({
      where: { id: { in: dto.cartItemIds } },
      include: {
        cart: true,
        productVariant: { include: { product: true } },
      },
    });
    if (
      cartItems.length !== dto.cartItemIds.length ||
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

          for (const item of cartItems) {
            await tx.stockMovement.create({
              data: {
                productVariantId: item.productVariantId,
                type: StockMovementType.EXPORT,
                quantity: -item.quantity,
                createdById: null,
              },
            });
            await tx.productVariant.update({
              where: { id: item.productVariantId },
              data: { stockQuantity: { decrement: item.quantity } },
            });
          }

          const created = await tx.order.create({
            data: {
              userId,
              orderCode,
              status: OrderStatus.PENDING,
              totalAmount,
              shippingAddress,
              paymentMethod: dto.paymentMethod,
              items: { create: itemsData },
            },
            include: { items: true },
          });

          await tx.orderStatusHistory.create({
            data: {
              orderId: created.id,
              fromStatus: null,
              toStatus: OrderStatus.PENDING,
              changedById: null,
            },
          });

          await tx.cartItem.deleteMany({
            where: { id: { in: dto.cartItemIds } },
          });

          return created;
        });

        void this.sendConfirmationEmailBestEffort(userId, order);
        return order;
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
      select: { id: true, name: true, thumbnail: true },
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

  // Best-effort — gửi mail xác nhận không phải điều kiện để coi đơn hàng đã tạo thành
  // công. Không await ở call site (createOrder) để không làm chậm response chờ SMTP.
  private async sendConfirmationEmailBestEffort(
    userId: string,
    order: { orderCode: string; totalAmount: Prisma.Decimal },
  ): Promise<void> {
    try {
      const user = await this.prisma.user.findUniqueOrThrow({
        where: { id: userId },
        select: { email: true },
      });
      await this.mail.sendOrderConfirmationEmail(user.email, {
        orderCode: order.orderCode,
        totalAmount: order.totalAmount.toNumber(),
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
