import { Product } from '@prisma/client';
import { ProductStatus } from '../../modules/products/product-status.enum';

// "Khả dụng để mua" phải xét cả 2 điều kiện: status ACTIVE VÀ chưa bị xóa mềm — sản phẩm
// bị admin xóa mềm bên backend-cms (ProductsService.remove() chỉ set isDelete: true,
// không đổi status) vẫn còn status ACTIVE. Dùng chung giữa CartService và OrdersService,
// không copy-paste lại.
export function isProductAvailable(
  product: Pick<Product, 'status' | 'isDelete'>,
): boolean {
  // Product.status là Int thô ở tầng Prisma (không phải enum DB) — gán qua biến khai kiểu
  // ProductStatus trước khi so sánh, khớp pattern đã dùng ở chỗ khác trong repo, để không
  // dính lint no-unsafe-enum-comparison (so number thô với enum TS).
  const status: ProductStatus = product.status;
  return status === ProductStatus.ACTIVE && !product.isDelete;
}
