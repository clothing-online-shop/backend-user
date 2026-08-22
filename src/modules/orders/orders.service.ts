import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  Order,
  OrderStatus,
  PaymentStatus,
  Prisma,
  StockMovementType,
} from '@prisma/client';
import { PrismaService } from '../../config/prisma.service';
import { CartService } from '../cart/cart.service';
import { CreateOrderDto } from './dto/create-order.dto';

const ORDER_CODE_MAX_ATTEMPTS = 5;

type RawOrderItem = {
  id: string;
  productVariantId: string;
  quantity: number;
  priceAtPurchase: Prisma.Decimal;
};
type RawOrderWithItems = Order & { items: RawOrderItem[] };

export interface OrderItemResponse {
  id: string;
  productVariantId: string;
  quantity: number;
  priceAtPurchase: number;
}
// totalAmount/priceAtPurchase là Prisma.Decimal ở tầng DB — JSON.stringify() mặc định biến
// Decimal thành CHUỖI (không phải number), FE nhận "200000" thay vì 200000 nếu trả thẳng
// object Prisma ra response. Luôn convert bằng .toNumber() trước khi trả — đúng cách
// toCartResponse() ở cart.service.ts đang làm.
export interface OrderResponse extends Omit<Order, 'totalAmount'> {
  totalAmount: number;
  items: OrderItemResponse[];
}

@Injectable()
export class OrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cartService: CartService,
  ) {}

  // Chốt giỏ hàng thành 1 đơn hàng thật: rà lại tồn kho lần cuối, trừ kho + ghi sổ kho,
  // xóa sạch giỏ. Đây là nền tảng bắt buộc cho toàn bộ luồng thanh toán (Sprint 5) — trước
  // đây chưa có API nào tạo đơn, dù các task thanh toán đều giả định đơn đã tồn tại.
  async createOrder(
    userId: string,
    dto: CreateOrderDto,
  ): Promise<OrderResponse> {
    await this.cartService.validateCart(userId);

    const cart = await this.prisma.cart.findFirst({
      where: { userId },
      include: {
        items: { include: { productVariant: { include: { product: true } } } },
      },
    });
    if (!cart || cart.items.length === 0) {
      throw new BadRequestException('Giỏ hàng trống, không thể đặt hàng.');
    }

    const address = await this.prisma.address.findUnique({
      where: { id: dto.addressId },
      include: { province: true, district: true, ward: true },
    });
    if (!address || address.userId !== userId) {
      throw new NotFoundException('Không tìm thấy địa chỉ.');
    }

    const shippingAddress = `${address.receiverName} - ${address.phone} - ${address.detail}, ${address.ward.name}, ${address.district.name}, ${address.province.name}`;
    const totalAmount = cart.items.reduce(
      (sum, item) => sum + item.productVariant.price.toNumber() * item.quantity,
      0,
    );

    for (let attempt = 1; attempt <= ORDER_CODE_MAX_ATTEMPTS; attempt++) {
      const orderCode = generateOrderCode();
      try {
        const order = await this.prisma.$transaction(async (tx) => {
          for (const item of cart.items) {
            // updateMany + điều kiện tồn kho ngay trong where — chặn race giữa lúc
            // validateCart() rà soát ở trên và lúc trừ kho thật ở đây (1 request khác mua
            // hết hàng đúng trong khoảng đó). count === 0 nghĩa là không còn đủ hàng.
            const { count } = await tx.productVariant.updateMany({
              where: {
                id: item.productVariantId,
                stockQuantity: { gte: item.quantity },
              },
              data: { stockQuantity: { decrement: item.quantity } },
            });
            if (count === 0) {
              throw new ConflictException(
                `Sản phẩm "${item.productVariant.product.name}" vừa hết hàng, vui lòng cập nhật giỏ hàng.`,
              );
            }
          }

          const order = await tx.order.create({
            data: {
              userId,
              orderCode,
              status: OrderStatus.PENDING,
              totalAmount,
              shippingAddress,
              paymentMethod: dto.paymentMethod,
              paymentStatus: PaymentStatus.UNPAID,
              items: {
                create: cart.items.map((item) => ({
                  productVariantId: item.productVariantId,
                  quantity: item.quantity,
                  priceAtPurchase: item.productVariant.price,
                })),
              },
            },
            include: { items: true },
          });

          await tx.stockMovement.createMany({
            data: cart.items.map((item) => ({
              productVariantId: item.productVariantId,
              type: StockMovementType.EXPORT,
              quantity: -item.quantity,
              note: `Trừ kho khi tạo đơn ${orderCode}`,
              createdById: null,
            })),
          });

          await tx.cartItem.deleteMany({ where: { cartId: cart.id } });

          return order;
        });
        return toOrderResponse(order);
      } catch (err) {
        const isOrderCodeCollision =
          err instanceof Prisma.PrismaClientKnownRequestError &&
          err.code === 'P2002';
        if (!isOrderCodeCollision || attempt === ORDER_CODE_MAX_ATTEMPTS) {
          throw err;
        }
      }
    }
    // Không bao giờ tới đây — vòng lặp trên luôn return hoặc throw ở lần thử cuối.
    throw new Error('unreachable');
  }

  async findOwnedOrder(
    userId: string,
    orderId: string,
  ): Promise<OrderResponse> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { items: true },
    });
    if (!order || order.userId !== userId) {
      throw new NotFoundException('Không tìm thấy đơn hàng.');
    }
    return toOrderResponse(order);
  }
}

function generateOrderCode(): string {
  const timePart = Date.now().toString(36).toUpperCase();
  const randomPart = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `ORD${timePart}${randomPart}`;
}

function toOrderResponse(order: RawOrderWithItems): OrderResponse {
  return {
    ...order,
    totalAmount: order.totalAmount.toNumber(),
    items: order.items.map((item) => ({
      id: item.id,
      productVariantId: item.productVariantId,
      quantity: item.quantity,
      priceAtPurchase: item.priceAtPurchase.toNumber(),
    })),
  };
}
