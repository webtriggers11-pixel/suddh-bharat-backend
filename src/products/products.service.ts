import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, Product } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { slugify, uniqueSlug } from '../common/slug.util';
import {
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
 * Product catalog (ADR-0010). Money is integer paise. Storefront reads see only
 * active, non-deleted products; admin flows pass `includeInactive`.
 */
@Injectable()
export class ProductsService {
  constructor(private readonly prisma: PrismaService) {}

  private base(includeInactive: boolean): Prisma.ProductWhereInput {
    return includeInactive
      ? { deletedAt: null }
      : { deletedAt: null, isActive: true };
  }

  async list(
    query: ProductQueryDto,
    includeInactive = false,
  ): Promise<Paginated<Product>> {
    const page = query.page ?? 1;
    const pageSize = Math.min(query.pageSize ?? 20, 100);
    const where = await this.buildWhere(query, includeInactive);
    const orderBy = this.buildOrderBy(query.sort);

    const [total, items] = await this.prisma.$transaction([
      this.prisma.product.count({ where }),
      this.prisma.product.findMany({
        where,
        orderBy,
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    return {
      items,
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize) || 0,
    };
  }

  async getBySlug(slug: string, includeInactive = false): Promise<Product> {
    const product = await this.prisma.product.findFirst({
      where: { ...this.base(includeInactive), slug },
    });
    if (!product) throw new NotFoundException('Product not found');
    return product;
  }

  async create(dto: CreateProductDto): Promise<Product> {
    await this.assertSkuFree(dto.sku);
    const slug = await this.resolveSlug(dto.slug ?? dto.name);
    return this.prisma.product.create({
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

    return this.prisma.product.update({
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
  }

  async remove(id: string): Promise<{ id: string }> {
    await this.requireById(id);
    await this.prisma.product.update({
      where: { id },
      data: { deletedAt: new Date(), isActive: false },
    });
    return { id };
  }

  // --- internals ---

  private async buildWhere(
    query: ProductQueryDto,
    includeInactive: boolean,
  ): Promise<Prisma.ProductWhereInput> {
    const where: Prisma.ProductWhereInput = this.base(includeInactive);
    const and: Prisma.ProductWhereInput[] = [];

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
