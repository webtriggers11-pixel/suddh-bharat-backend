import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { slugify } from '../common/slug.util';
import { parseCsv } from './csv.util';

export type RowStatus = 'created' | 'updated' | 'revived' | 'skipped';

export interface RowResult {
  row: number;
  sku: string | null;
  name: string;
  status: RowStatus;
  error?: string;
  warnings?: string[];
}

export interface BulkResult {
  dryRun: boolean;
  total: number;
  created: number;
  updated: number;
  revived: number;
  skipped: number;
  rows: RowResult[];
}

/** Normalize a header cell to a lookup key. */
const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

const YES = new Set(['yes', 'y', 'true', '1']);

/**
 * Bulk product import from CSV text (spec 07). SKU is the match key: an existing
 * SKU updates (reviving a soft-deleted row), a new SKU creates. A dry run
 * validates without persisting. Money columns are rupees → integer paise.
 */
@Injectable()
export class BulkUploadService {
  constructor(private readonly prisma: PrismaService) {}

  async run(content: string, dryRun: boolean): Promise<BulkResult> {
    const table = parseCsv(content);
    const result: BulkResult = {
      dryRun,
      total: 0,
      created: 0,
      updated: 0,
      revived: 0,
      skipped: 0,
      rows: [],
    };
    if (table.length < 2) return result; // header + at least one row

    const header = table[0].map(norm);
    const idx = (name: string) => header.indexOf(norm(name));
    const col = (cells: string[], name: string) => {
      const i = idx(name);
      return i >= 0 ? (cells[i] ?? '').trim() : '';
    };

    for (let r = 1; r < table.length; r++) {
      const cells = table[r];
      const rowNum = r + 1; // 1-based, header is row 1
      result.total++;
      const name = col(cells, 'Product Name');
      const sku = col(cells, 'SKU') || null;
      const warnings: string[] = [];

      try {
        if (!name) throw new Error('Product Name is required');
        const priceRaw = col(cells, 'Price');
        const mrpRaw = col(cells, 'MRP');
        const priceMinor = this.toMinor(priceRaw);
        const mrpMinor = this.toMinor(mrpRaw);
        if (priceMinor === null)
          throw new Error('Price is required and numeric');
        if (mrpMinor === null) throw new Error('MRP is required and numeric');

        const categoryPath = col(cells, 'Category Path');
        const categoryId = categoryPath
          ? await this.resolveCategory(categoryPath, warnings)
          : null;

        const data: Prisma.ProductUncheckedCreateInput = {
          name,
          slug: slugify(name),
          description: col(cells, 'Description') || null,
          priceMinor,
          mrpMinor,
          stock: this.toInt(col(cells, 'Stock')) ?? 0,
          sku,
          collection: col(cells, 'Collection') || null,
          material: col(cells, 'Material') || null,
          color: col(cells, 'Color') || null,
          hsnCode: col(cells, 'HSN Code') || null,
          weightKg: this.toFloat(col(cells, 'Weight (kg)')),
          lengthCm: this.toFloat(col(cells, 'Length (cm)')),
          breadthCm: this.toFloat(col(cells, 'Breadth (cm)')),
          heightCm: this.toFloat(col(cells, 'Height (cm)')),
          tags: this.splitTags(col(cells, 'Tags')),
          isHandmade: YES.has(col(cells, 'Handmade (Yes/No)').toLowerCase()),
          isFeatured: YES.has(col(cells, 'Featured (Yes/No)').toLowerCase()),
          isNew: YES.has(col(cells, 'New Arrival (Yes/No)').toLowerCase()),
          isBestseller: YES.has(
            col(cells, 'Bestseller (Yes/No)').toLowerCase(),
          ),
          ...(categoryId ? { categoryId } : {}),
        };

        const productUrl = col(cells, 'Product URL');
        if (productUrl) {
          if (dryRun) {
            // images fetched only on the real import
          } else {
            data.images = productUrl
              .split(',')
              .map((u) => u.trim())
              .filter(Boolean);
          }
        }

        // Determine create / update / revive by SKU.
        const existing = sku
          ? await this.prisma.product.findUnique({ where: { sku } })
          : null;

        let status: RowStatus;
        if (existing) {
          status = existing.deletedAt ? 'revived' : 'updated';
        } else {
          status = 'created';
        }

        if (!dryRun) {
          if (existing) {
            const { slug, ...rest } = data;
            void slug; // keep the existing slug on update
            await this.prisma.product.update({
              where: { id: existing.id },
              data: {
                ...rest,
                // Only a revive clears the soft-delete + reactivates; a plain
                // update must not silently undo an admin's manual deactivation.
                ...(status === 'revived'
                  ? { deletedAt: null, isActive: true }
                  : {}),
              },
            });
          } else {
            await this.prisma.product.create({
              data: { ...data, slug: await this.uniqueSlug(data.slug) },
            });
          }
        }

        result[status]++;
        result.rows.push({
          row: rowNum,
          sku,
          name,
          status,
          ...(warnings.length ? { warnings } : {}),
        });
      } catch (err) {
        result.skipped++;
        result.rows.push({
          row: rowNum,
          sku,
          name: name || '(unnamed)',
          status: 'skipped',
          error: err instanceof Error ? err.message : String(err),
          ...(warnings.length ? { warnings } : {}),
        });
      }
    }
    return result;
  }

  // ---- helpers -------------------------------------------------------------

  private toMinor(raw: string): number | null {
    if (!raw) return null;
    const n = Number(raw.replace(/[₹,\s]/g, ''));
    return Number.isFinite(n) ? Math.round(n * 100) : null;
  }

  private toInt(raw: string): number | null {
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? Math.trunc(n) : null;
  }

  private toFloat(raw: string): number | null {
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }

  private splitTags(raw: string): string[] {
    return raw
      ? raw
          .split(/[,;]/)
          .map((t) => t.trim())
          .filter(Boolean)
      : [];
  }

  /** Resolve "Parent > Child" by walking the full chain level by level (each
   * segment must match under its exact parent), so same-named categories
   * under different parents (e.g. "Men > Rings" vs "Women > Rings") aren't
   * conflated. Returns the deepest matching category id, or warns. */
  private async resolveCategory(
    path: string,
    warnings: string[],
  ): Promise<string | null> {
    const segments = path
      .split('>')
      .map((s) => s.trim())
      .filter(Boolean);
    if (!segments.length) return null;

    let parentId: string | null = null;
    let matchId: string | null = null;
    for (const segment of segments) {
      const match: { id: string } | null = await this.prisma.category.findFirst(
        {
          where: {
            name: { equals: segment, mode: 'insensitive' },
            parentId,
            deletedAt: null,
          },
          select: { id: true },
        },
      );
      if (!match) {
        warnings.push(`Category "${path}" not found — left uncategorised`);
        return null;
      }
      parentId = match.id;
      matchId = match.id;
    }
    return matchId;
  }

  private async uniqueSlug(base: string): Promise<string> {
    let slug = base || 'product';
    let n = 1;
    while (await this.prisma.product.findUnique({ where: { slug } })) {
      slug = `${base}-${n++}`;
    }
    return slug;
  }
}
