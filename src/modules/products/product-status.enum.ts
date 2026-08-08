// Mirror của backend-cms/src/modules/products/product-status.enum.ts — Product.status là
// Int trong DB (không phải Prisma enum), giữ nhất quán mapping khi backend-cms đổi.
export enum ProductStatus {
  DRAFT = 0,
  ACTIVE = 1,
  INACTIVE = 2,
}
