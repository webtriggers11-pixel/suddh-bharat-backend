import { Prisma } from '@prisma/client';

/** A product + quantity to reserve or release. */
export interface StockLine {
  productId: string;
  quantity: number;
}

/**
 * Reserve stock for many lines in ONE statement (not N awaited round-trips —
 * Prisma interactive transactions can't run queries concurrently, so a loop pins
 * the connection per item). Atomic + conditional: a row is decremented only if
 * it's active and has `stock >= qty`. Returns true iff EVERY line was reserved;
 * on a partial shortfall the sufficient lines are still decremented (the caller
 * decides whether that's a hard failure or a flag-for-review).
 *
 * Assumes one line per product (cart lines / order items are unique per product).
 */
export async function reserveStock(
  tx: Prisma.TransactionClient,
  lines: StockLine[],
): Promise<boolean> {
  if (lines.length === 0) return true;
  const ids = lines.map((l) => l.productId);
  const qtys = lines.map((l) => l.quantity);
  const updated = await tx.$queryRaw<{ id: string }[]>`
    UPDATE "Product" AS p
       SET "stock" = p."stock" - d.qty, "updatedAt" = now()
      FROM (
        SELECT UNNEST(${ids}::text[]) AS id, UNNEST(${qtys}::int[]) AS qty
      ) AS d
     WHERE p."id" = d.id
       AND p."isActive" = true
       AND p."deletedAt" IS NULL
       AND p."stock" >= d.qty
    RETURNING p."id" AS id`;
  return updated.length === lines.length;
}

/** Release (add back) stock for many lines in one statement — no condition. */
export async function releaseStock(
  tx: Prisma.TransactionClient,
  lines: StockLine[],
): Promise<void> {
  if (lines.length === 0) return;
  const ids = lines.map((l) => l.productId);
  const qtys = lines.map((l) => l.quantity);
  await tx.$executeRaw`
    UPDATE "Product" AS p
       SET "stock" = p."stock" + d.qty, "updatedAt" = now()
      FROM (
        SELECT UNNEST(${ids}::text[]) AS id, UNNEST(${qtys}::int[]) AS qty
      ) AS d
     WHERE p."id" = d.id`;
}
