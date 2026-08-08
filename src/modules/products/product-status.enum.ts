// Lưu dạng số trong DB (Product.status là Int, không phải Prisma enum) — khớp
// backend-cms/src/modules/products/product-status.enum.ts, nguồn thật của quy ước này
// (2 backend dùng chung 1 bảng products).
export enum ProductStatus {
  DRAFT = 0,
  ACTIVE = 1,
  INACTIVE = 2,
}
