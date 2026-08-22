-- ---- Partial indexes limited to LIVE (non-soft-deleted) rows (T9) -----------
-- Every storefront and user-scoped read filters `deletedAt IS NULL`. A partial
-- index over just the live rows is smaller, stays hot in cache, and lets the
-- planner satisfy the soft-delete predicate from the index alone instead of
-- rechecking the heap. Raw SQL because Prisma cannot express a WHERE predicate
-- on @@index (same reason the pg_trgm indexes live here).

-- Product catalog browse — the storefront list()/buildWhere always adds
-- deletedAt IS NULL (+ isActive). These shadow the full btree indexes with a
-- live-only variant for the hot public path.
CREATE INDEX IF NOT EXISTS "Product_category_live_idx"
  ON "Product" ("categoryId", "isActive", "createdAt")
  WHERE "deletedAt" IS NULL;
CREATE INDEX IF NOT EXISTS "Product_active_created_live_idx"
  ON "Product" ("isActive", "createdAt")
  WHERE "deletedAt" IS NULL;
CREATE INDEX IF NOT EXISTS "Product_active_price_live_idx"
  ON "Product" ("isActive", "priceMinor")
  WHERE "deletedAt" IS NULL;

-- Category slug resolution — buildWhere() resolves category/subcategory slugs
-- with findFirst({ slug, deletedAt: null }).
CREATE INDEX IF NOT EXISTS "Category_slug_live_idx"
  ON "Category" ("slug")
  WHERE "deletedAt" IS NULL;

-- Order reads are always scoped to live rows: user order history
-- (userId, createdAt) and single-order fetch by id both add deletedAt IS NULL.
CREATE INDEX IF NOT EXISTS "Order_user_created_live_idx"
  ON "Order" ("userId", "createdAt")
  WHERE "deletedAt" IS NULL;

-- Address book — findMany({ userId, deletedAt: null }) ordered by isDefault.
CREATE INDEX IF NOT EXISTS "Address_user_live_idx"
  ON "Address" ("userId", "isDefault")
  WHERE "deletedAt" IS NULL;
