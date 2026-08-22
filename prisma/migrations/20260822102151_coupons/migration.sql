-- CreateEnum
CREATE TYPE "DiscountType" AS ENUM ('PERCENTAGE', 'FIXED');

-- DropIndex
DROP INDEX IF EXISTS "Order_shipName_trgm_idx";

-- DropIndex
DROP INDEX IF EXISTS "Order_shipPhone_trgm_idx";

-- DropIndex
DROP INDEX IF EXISTS "Product_description_trgm_idx";

-- DropIndex
DROP INDEX IF EXISTS "Product_name_trgm_idx";

-- DropIndex
DROP INDEX IF EXISTS "Product_sku_trgm_idx";

-- DropIndex
DROP INDEX IF EXISTS "Product_slug_trgm_idx";

-- DropIndex
DROP INDEX IF EXISTS "Product_tags_gin_idx";

-- CreateTable
CREATE TABLE "Coupon" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "discountType" "DiscountType" NOT NULL,
    "discountValue" INTEGER NOT NULL,
    "minOrderMinor" INTEGER NOT NULL DEFAULT 0,
    "maxDiscountMinor" INTEGER,
    "usageLimit" INTEGER,
    "usedCount" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Coupon_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Coupon_code_key" ON "Coupon"("code");
