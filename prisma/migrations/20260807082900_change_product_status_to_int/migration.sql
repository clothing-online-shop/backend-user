-- Đổi products.status từ Postgres enum (string) sang Int — giữ nguyên dữ liệu hiện có
-- bằng cách backfill qua cột tạm thay vì để Prisma tự sinh ALTER COLUMN TYPE (ENUM không tự
-- ép sang integer, sẽ mất dữ liệu). Ánh xạ: DRAFT=0, ACTIVE=1, INACTIVE=2 (khớp
-- src/modules/products/product-status.enum.ts).

ALTER TABLE "products" ADD COLUMN "status_new" INTEGER;

UPDATE "products" SET "status_new" = CASE "status"
  WHEN 'DRAFT' THEN 0
  WHEN 'ACTIVE' THEN 1
  WHEN 'INACTIVE' THEN 2
END;

ALTER TABLE "products" ALTER COLUMN "status_new" SET NOT NULL;
ALTER TABLE "products" ALTER COLUMN "status_new" SET DEFAULT 0;

ALTER TABLE "products" DROP COLUMN "status";
ALTER TABLE "products" RENAME COLUMN "status_new" TO "status";

DROP TYPE "ProductStatus";
