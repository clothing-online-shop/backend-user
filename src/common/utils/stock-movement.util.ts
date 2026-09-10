import { Prisma, StockMovementType } from '@prisma/client';

/**
 * Ghi StockMovement + cập nhật stockQuantity của variant (2 thao tác luôn đi cùng nhau).
 * `quantity` truyền DƯƠNG; chiều lấy từ `type`: EXPORT giảm kho, IMPORT/RETURN tăng kho.
 * Không dùng cho ADJUSTMENT (đi được cả 2 chiều).
 */
export async function applyStockMovement(
  tx: Prisma.TransactionClient,
  params: {
    productVariantId: string;
    type: StockMovementType;
    quantity: number;
    createdById?: string | null;
  },
): Promise<void> {
  const isOutbound = params.type === StockMovementType.EXPORT;

  await tx.stockMovement.create({
    data: {
      productVariantId: params.productVariantId,
      type: params.type,
      quantity: isOutbound ? -params.quantity : params.quantity,
      createdById: params.createdById ?? null,
    },
  });

  await tx.productVariant.update({
    where: { id: params.productVariantId },
    data: {
      stockQuantity: isOutbound
        ? { decrement: params.quantity }
        : { increment: params.quantity },
    },
  });
}
