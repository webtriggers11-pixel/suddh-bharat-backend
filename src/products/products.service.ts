import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, Product } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RevalidateService } from '../common/revalidate.service';
import { slugify, uniqueSlug } from '../common/slug.util';
import {
  AdminProductQueryDto,
  CreateProductDto,
  ProductQueryDto,
  UpdateProductDto,
} from './dto/product.dto';

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

/**
 * Storefront listing projection — exactly the columns a product card renders.
 * Deliberately omits the heavy/irrelevant logistics + audit columns
 * (sku, hsnCode, weight/dimensions, createdAt/updatedAt/deletedAt) so a paged
 * catalog read doesn't ship kilobytes per row that no card uses (T8).
 */
export const PRODUCT_CARD_SELECT = {
  id: true,
  name: true,
  slug: true,
  description: true,
  priceMinor: true,
  mrpMinor: true,
  stock: true,
  images: true,
  categoryId: true,
  tags: true,
  collection: true,
  material: true,
  color: true,
  isActive: true,
  isHandmade: true,
  isFeatured: true,
  isNew: true,
  isBestseller: true,
  avgRating: true,
  reviewCount: true,
} satisfies Prisma.ProductSelect;

export type ProductCard = Prisma.ProductGetPayload<{
  select: typeof PRODUCT_CARD_SELECT;
}>;

/**
 * Admin listing projection (BUG-002). The card projection plus the logistics +
 * audit columns the dashboard table renders (SKU, created/updated) — reading
 * the storefront projection there left those cells permanently blank.
 */
export const PRODUCT_ADMIN_SELECT = {
  ...PRODUCT_CARD_SELECT,
  sku: true,
  hsnCode: true,
  weightKg: true,
  lengthCm: true,
  breadthCm: true,
  heightCm: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.ProductSelect;

export type ProductAdminRow = Prisma.ProductGetPayload<{
  select: typeof PRODUCT_ADMIN_SELECT;
}>;

/**
 * Product catalog (ADR-0010). Money is integer paise. Storefront reads see only
 * active, non-deleted products; admin flows pass `includeInactive`.
 */
@Injectable()
export class ProductsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly revalidate: RevalidateService,
  ) {}

  private base(includeInactive: boolean): Prisma.ProductWhereInput {
    return includeInactive
      ? { deletedAt: null }
      : { deletedAt: null, isActive: true };
  }

  async list(
    query: ProductQueryDto,
    includeInactive = false,
  ): Promise<Paginated<ProductCard>> {
    const { page, pageSize, where, orderBy, skip, take } = await this.pageQuery(
      query,
      includeInactive,
    );

    const [total, items] = await this.prisma.$transaction([
      this.prisma.product.count({ where }),
      this.prisma.product.findMany({
        where,
        orderBy,
        skip,
        take,
        select: PRODUCT_CARD_SELECT,
      }),
    ]);

    return this.paginated(items, total, page, pageSize);
  }

  /**
   * Admin catalogue listing (BUG-002). Sees inactive products — soft-deleted
   * rows stay hidden — and ships the wider admin projection. `status` narrows
   * to active-only / inactive-only for the dashboard's filter.
   */
  async listAdmin(
    query: AdminProductQueryDto,
  ): Promise<Paginated<ProductAdminRow>> {
    const { page, pageSize, where, orderBy, skip, take } = await this.pageQuery(
      query,
      true,
    );

    const [total, items] = await this.prisma.$transaction([
      this.prisma.product.count({ where }),
      this.prisma.product.findMany({
        where,
        orderBy,
        skip,
        take,
        select: PRODUCT_ADMIN_SELECT,
      }),
    ]);

    return this.paginated(items, total, page, pageSize);
  }

  /**
   * Autocomplete for the search bar. Returns up to 6 matching products (with the
   * bits a suggestion row needs) plus distinct name suggestions. Empty for a
   * search under 2 chars. Reuses the same visibility + search rules as `list`.
   */
  async suggest(
    query: ProductQueryDto,
    includeInactive = false,
  ): Promise<{
    products: {
      id: string;
      name: string;
      slug: string;
      image: string | null;
      priceMinor: number;
    }[];
    suggestions: string[];
  }> {
    const q = (query.search ?? '').trim();
    if (q.length < 2) return { products: [], suggestions: [] };

    const where = await this.buildWhere(
      { ...query, search: q },
      includeInactive,
    );
    const rows = await this.prisma.product.findMany({
      where,
      orderBy: [
        { isBestseller: 'desc' },
        { reviewCount: 'desc' },
        { createdAt: 'desc' },
      ],
      take: 6,
      select: {
        id: true,
        name: true,
        slug: true,
        priceMinor: true,
        images: true,
      },
    });

    const products = rows.map((p) => ({
      id: p.id,
      name: p.name,
      slug: p.slug,
      image: p.images[0] ?? null,
      priceMinor: p.priceMinor,
    }));
    const suggestions = Array.from(new Set(rows.map((p) => p.name))).slice(
      0,
      6,
    );
    return { products, suggestions };
  }

  async getBySlug(slug: string, includeInactive = false): Promise<Product> {
    const product = await this.prisma.product.findFirst({
      where: { ...this.base(includeInactive), slug },
    });
    if (!product) throw new NotFoundException('Product not found');
    return product;
  }

  /**
   * Admin product read (BUG-002). Resolves by id *or* slug and ignores
   * `isActive`, so the dashboard can open — and therefore reactivate — a
   * product the storefront hides. Soft-deleted rows still 404.
   */
  async getForAdmin(idOrSlug: string): Promise<Product> {
    const product = await this.prisma.product.findFirst({
      where: { deletedAt: null, OR: [{ id: idOrSlug }, { slug: idOrSlug }] },
    });
    if (!product) throw new NotFoundException('Product not found');
    return product;
  }

  /**
   * "You may also like" rail (FEAT-017a). Up to 8 other active, in-stock
   * products sharing the given product's category, newest/most-notable first.
   * No category, or no product found at all, → `[]` (not an error) so the
   * storefront can hide the section rather than break the page.
   */
  async findRelated(slug: string): Promise<ProductCard[]> {
    const product = await this.prisma.product.findFirst({
      where: { ...this.base(false), slug },
      select: { id: true, categoryId: true },
    });
    if (!product || !product.categoryId) return [];

    return this.prisma.product.findMany({
      where: {
        ...this.base(false),
        categoryId: product.categoryId,
        stock: { gt: 0 },
        NOT: { id: product.id },
      },
      orderBy: [
        { isBestseller: 'desc' },
        { isNew: 'desc' },
        { createdAt: 'desc' },
      ],
      take: 8,
      select: PRODUCT_CARD_SELECT,
    });
  }

  async create(dto: CreateProductDto): Promise<Product> {
    await this.assertSkuFree(dto.sku);
    const slug = await this.resolveSlug(dto.slug ?? dto.name);
    const created = await this.prisma.product.create({
      data: {
        name: dto.name,
        slug,
        description: dto.description,
        priceMinor: dto.priceMinor,
        mrpMinor: dto.mrpMinor,
        stock: dto.stock ?? 0,
        images: dto.images ?? [],
        categoryId: dto.categoryId,
        tags: dto.tags ?? [],
        collection: dto.collection,
        sku: dto.sku,
        hsnCode: dto.hsnCode,
        material: dto.material,
        color: dto.color,
        weightKg: dto.weightKg,
        lengthCm: dto.lengthCm,
        breadthCm: dto.breadthCm,
        heightCm: dto.heightCm,
        isActive: dto.isActive ?? true,
        isHandmade: dto.isHandmade ?? true,
        isFeatured: dto.isFeatured ?? false,
        isNew: dto.isNew ?? false,
        isBestseller: dto.isBestseller ?? false,
      },
    });
    this.revalidate.revalidate(['products', `product:${created.slug}`]);
    return created;
  }

  async update(id: string, dto: UpdateProductDto): Promise<Product> {
    const existing = await this.requireById(id);
    if (dto.sku && dto.sku !== existing.sku) {
      await this.assertSkuFree(dto.sku, id);
    }
    let slug = existing.slug;
    if (dto.slug) slug = await this.resolveSlug(dto.slug, id);
    else if (dto.name && dto.name !== existing.name)
      slug = await this.resolveSlug(dto.name, id);

    const updated = await this.prisma.product.update({
      where: { id },
      data: {
        name: dto.name,
        slug,
        description: dto.description,
        priceMinor: dto.priceMinor,
        mrpMinor: dto.mrpMinor,
        stock: dto.stock,
        images: dto.images,
        categoryId: dto.categoryId,
        tags: dto.tags,
        collection: dto.collection,
        sku: dto.sku,
        hsnCode: dto.hsnCode,
        material: dto.material,
        color: dto.color,
        weightKg: dto.weightKg,
        lengthCm: dto.lengthCm,
        breadthCm: dto.breadthCm,
        heightCm: dto.heightCm,
        isActive: dto.isActive,
        isHandmade: dto.isHandmade,
        isFeatured: dto.isFeatured,
        isNew: dto.isNew,
        isBestseller: dto.isBestseller,
      },
    });
    this.revalidate.revalidate([
      'products',
      `product:${existing.slug}`,
      `product:${slug}`,
    ]);
    return updated;
  }

  /**
   * Flip a product's storefront visibility (FEAT-020). A dedicated route so the
   * dashboard's row toggle cannot accidentally submit a partial product body
   * through the full update path, and so the storefront cache is busted for
   * exactly this product.
   */
  async setActive(id: string, isActive: boolean): Promise<Product> {
    const existing = await this.requireById(id);
    const updated = await this.prisma.product.update({
      where: { id },
      data: { isActive },
    });
    this.revalidate.revalidate(['products', `product:${existing.slug}`]);
    return updated;
  }

  async remove(id: string): Promise<{ id: string }> {
    const existing = await this.requireById(id);
    await this.prisma.product.update({
      where: { id },
      data: { deletedAt: new Date(), isActive: false },
    });
    this.revalidate.revalidate(['products', `product:${existing.slug}`]);
    return { id };
  }

  // --- internals ---

  /** Shared paging/filtering arithmetic for the public + admin listings. */
  private async pageQuery(
    query: AdminProductQueryDto,
    includeInactive: boolean,
  ) {
    const page = query.page ?? 1;
    const pageSize = Math.min(query.pageSize ?? 20, 100);
    return {
      page,
      pageSize,
      skip: (page - 1) * pageSize,
      take: pageSize,
      where: await this.buildWhere(query, includeInactive),
      orderBy: this.buildOrderBy(query.sort),
    };
  }

  private paginated<T>(
    items: T[],
    total: number,
    page: number,
    pageSize: number,
  ): Paginated<T> {
    return {
      items,
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize) || 0,
    };
  }

  private async buildWhere(
    query: AdminProductQueryDto,
    includeInactive: boolean,
  ): Promise<Prisma.ProductWhereInput> {
    const where: Prisma.ProductWhereInput = this.base(includeInactive);
    const and: Prisma.ProductWhereInput[] = [];

    // Admin visibility filter. Only meaningful with includeInactive (the public
    // base already pins isActive: true); 'all' leaves the field unconstrained.
    if (includeInactive && query.status && query.status !== 'all') {
      where.isActive = query.status === 'active';
    }

    // Filter precedence: categoryId > subcategorySlug > categorySlug.
    if (query.categoryId) {
      where.categoryId = query.categoryId;
    } else if (query.subcategorySlug) {
      const sub = await this.prisma.category.findFirst({
        where: { slug: query.subcategorySlug, deletedAt: null },
        select: { id: true },
      });
      where.categoryId = sub?.id ?? '__none__';
    } else if (query.categorySlug) {
      const top = await this.prisma.category.findFirst({
        where: { slug: query.categorySlug, parentId: null, deletedAt: null },
        include: { children: { select: { id: true } } },
      });
      if (top) {
        where.categoryId = {
          in: [top.id, ...top.children.map((c) => c.id)],
        };
      } else {
        where.categoryId = '__none__';
      }
    }

    if (query.isFeatured !== undefined) where.isFeatured = query.isFeatured;
    if (query.isNew !== undefined) where.isNew = query.isNew;
    if (query.isBestseller !== undefined)
      where.isBestseller = query.isBestseller;
    if (query.collection)
      where.collection = { contains: query.collection, mode: 'insensitive' };

    if (query.priceMin !== undefined || query.priceMax !== undefined) {
      where.priceMinor = {
        ...(query.priceMin !== undefined ? { gte: query.priceMin } : {}),
        ...(query.priceMax !== undefined ? { lte: query.priceMax } : {}),
      };
    }

    if (query.search && query.search.trim().length > 0) {
      const q = query.search.trim();
      and.push({
        OR: [
          { name: { contains: q, mode: 'insensitive' } },
          { description: { contains: q, mode: 'insensitive' } },
          { sku: { contains: q, mode: 'insensitive' } },
          { slug: { contains: q, mode: 'insensitive' } },
          { tags: { has: q.toLowerCase() } },
        ],
      });
    }

    if (and.length) where.AND = and;
    return where;
  }

  private buildOrderBy(
    sort?: 'price_asc' | 'price_desc',
  ): Prisma.ProductOrderByWithRelationInput[] {
    if (sort === 'price_asc') return [{ priceMinor: 'asc' }, { id: 'desc' }];
    if (sort === 'price_desc') return [{ priceMinor: 'desc' }, { id: 'desc' }];
    return [{ createdAt: 'desc' }, { id: 'desc' }];
  }

  private async requireById(id: string): Promise<Product> {
    const product = await this.prisma.product.findFirst({
      where: { id, deletedAt: null },
    });
    if (!product) throw new NotFoundException('Product not found');
    return product;
  }

  private async assertSkuFree(sku?: string, excludeId?: string): Promise<void> {
    if (!sku) return;
    const clash = await this.prisma.product.findFirst({
      where: {
        sku,
        deletedAt: null,
        ...(excludeId ? { NOT: { id: excludeId } } : {}),
      },
      select: { id: true },
    });
    if (clash) throw new ConflictException('SKU already in use');
  }

  private resolveSlug(base: string, excludeId?: string): Promise<string> {
    return uniqueSlug(slugify(base), async (candidate) => {
      const clash = await this.prisma.product.findFirst({
        where: {
          slug: candidate,
          ...(excludeId ? { NOT: { id: excludeId } } : {}),
        },
        select: { id: true },
      });
      return clash !== null;
    });
  }
}
