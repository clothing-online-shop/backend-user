-- AlterTable
ALTER TABLE "products" ADD COLUMN     "imagePublicIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "thumbnailPublicId" TEXT;
