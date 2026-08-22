-- DropIndex
DROP INDEX "Order_status_idx";

-- DropIndex
DROP INDEX "PaymentTransaction_gatewayOrderId_idx";

-- DropIndex
DROP INDEX "Product_categoryId_isActive_idx";

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "needsReview" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "Order_status_createdAt_idx" ON "Order"("status", "createdAt");

-- CreateIndex
CREATE INDEX "OrderItem_productId_idx" ON "OrderItem"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentTransaction_orderId_attempt_key" ON "PaymentTransaction"("orderId", "attempt");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentTransaction_gatewayOrderId_key" ON "PaymentTransaction"("gatewayOrderId");

-- CreateIndex
CREATE INDEX "Product_categoryId_isActive_createdAt_idx" ON "Product"("categoryId", "isActive", "createdAt");

-- CreateIndex
CREATE INDEX "Product_isActive_priceMinor_idx" ON "Product"("isActive", "priceMinor");


-- ---- Scale: trigram search indexes (raw SQL; Prisma can't express GIN) -------
-- Product search uses ILIKE '%q%' on the hot autocomplete path — a leading
-- wildcard cannot use a btree, so without these every search is a seq scan.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS "Product_name_trgm_idx"        ON "Product" USING gin (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "Product_description_trgm_idx" ON "Product" USING gin (description gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "Product_sku_trgm_idx"         ON "Product" USING gin (sku gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "Product_slug_trgm_idx"        ON "Product" USING gin (slug gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "Product_tags_gin_idx"         ON "Product" USING gin (tags);
-- Admin order search (ship* ILIKE)
CREATE INDEX IF NOT EXISTS "Order_shipName_trgm_idx"  ON "Order" USING gin ("shipName" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "Order_shipPhone_trgm_idx" ON "Order" USING gin ("shipPhone" gin_trgm_ops);
