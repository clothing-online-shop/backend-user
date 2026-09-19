import { Prisma, Product } from '@prisma/client';
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

// Điều kiện Prisma tương đương isProductAvailable() — dùng trong `where` (kể cả lọc qua quan
// hệ, vd `product: AVAILABLE_PRODUCT_WHERE`) để mọi truy vấn "sản phẩm hiển thị ở storefront"
// lọc chung 1 chuẩn. Trước đây mỗi nơi tự viết `status: ACTIVE` mà quên `isDelete: false`,
// khiến sản phẩm đã xóa mềm vẫn hiện trong danh sách/wishlist/đã xem gần đây.
export const AVAILABLE_PRODUCT_WHERE = {
  status: ProductStatus.ACTIVE,
  isDelete: false,
} satisfies Prisma.ProductWhereInput;
