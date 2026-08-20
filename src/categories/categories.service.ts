import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Category, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { slugify, uniqueSlug } from '../common/slug.util';
import { CreateCategoryDto, UpdateCategoryDto } from './dto/category.dto';

/**
 * Catalog category tree (ADR-0010). Self-referential; soft-deleted. Slugs are
 * unique within a parent scope. Storefront reads see active-only; admin reads
 * can include inactive.
 */
@Injectable()
export class CategoriesService {
  constructor(private readonly prisma: PrismaService) {}

  private notDeleted: Prisma.CategoryWhereInput = { deletedAt: null };

  /** Top-level categories with their children (one nesting level). */
  async tree(includeInactive = false): Promise<Category[]> {
    const activeFilter = includeInactive ? {} : { isActive: true };
    return this.prisma.category.findMany({
      where: { ...this.notDeleted, parentId: null, ...activeFilter },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      include: {
        children: {
          where: { ...this.notDeleted, ...activeFilter },
          orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
        },
      },
    });
  }

  /** Flat list of all categories. */
  async flat(includeInactive = false): Promise<Category[]> {
    const activeFilter = includeInactive ? {} : { isActive: true };
    return this.prisma.category.findMany({
      where: { ...this.notDeleted, ...activeFilter },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
  }

  /** A top-level (or any) category by slug + its active children. */
  async getBySlug(slug: string, includeInactive = false): Promise<Category> {
    const activeFilter = includeInactive ? {} : { isActive: true };
    const category = await this.prisma.category.findFirst({
      where: { ...this.notDeleted, slug, ...activeFilter },
      include: {
        children: {
          where: { ...this.notDeleted, ...activeFilter },
          orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
        },
      },
    });
    if (!category) throw new NotFoundException('Category not found');
    return category;
  }

  /** A subcategory validated to belong to the parent identified by `slug`. */
  async getSubcategory(slug: string, subSlug: string): Promise<Category> {
    const parent = await this.prisma.category.findFirst({
      where: { ...this.notDeleted, slug, parentId: null, isActive: true },
    });
    if (!parent) throw new NotFoundException('Category not found');
    const sub = await this.prisma.category.findFirst({
      where: {
        ...this.notDeleted,
        slug: subSlug,
        parentId: parent.id,
        isActive: true,
      },
    });
    if (!sub) throw new NotFoundException('Subcategory not found');
    return sub;
  }

  async create(dto: CreateCategoryDto): Promise<Category> {
    await this.assertUniqueName(dto.name, dto.parentId ?? null);
    const slug = await this.resolveSlug(
      dto.slug ?? dto.name,
      dto.parentId ?? null,
    );
    return this.prisma.category.create({
      data: {
        name: dto.name,
        slug,
        description: dto.description,
        image: dto.image,
        parentId: dto.parentId,
        sortOrder: dto.sortOrder ?? 0,
        isActive: dto.isActive ?? true,
      },
    });
  }

  async update(id: string, dto: UpdateCategoryDto): Promise<Category> {
    const existing = await this.requireById(id);
    const parentId =
      dto.parentId !== undefined ? dto.parentId : existing.parentId;
    if (dto.name && dto.name !== existing.name) {
      await this.assertUniqueName(dto.name, parentId, id);
    }
    let slug = existing.slug;
    if (dto.slug) {
      slug = await this.resolveSlug(dto.slug, parentId, id);
    } else if (dto.name && dto.name !== existing.name) {
      slug = await this.resolveSlug(dto.name, parentId, id);
    }
    return this.prisma.category.update({
      where: { id },
      data: {
        name: dto.name,
        slug,
        description: dto.description,
        image: dto.image,
        parentId: dto.parentId,
        sortOrder: dto.sortOrder,
        isActive: dto.isActive,
      },
    });
  }

  /** Soft delete. */
  async remove(id: string): Promise<{ id: string }> {
    await this.requireById(id);
    await this.prisma.category.update({
      where: { id },
      data: { deletedAt: new Date(), isActive: false },
    });
    return { id };
  }

  private async requireById(id: string): Promise<Category> {
    const category = await this.prisma.category.findFirst({
      where: { id, ...this.notDeleted },
    });
    if (!category) throw new NotFoundException('Category not found');
    return category;
  }

  private async assertUniqueName(
    name: string,
    parentId: string | null,
    excludeId?: string,
  ): Promise<void> {
    const clash = await this.prisma.category.findFirst({
      where: {
        ...this.notDeleted,
        parentId,
        name: { equals: name, mode: 'insensitive' },
        ...(excludeId ? { NOT: { id: excludeId } } : {}),
      },
    });
    if (clash) {
      throw new ConflictException(
        'A category with this name already exists here',
      );
    }
  }

  private resolveSlug(
    base: string,
    parentId: string | null,
    excludeId?: string,
  ): Promise<string> {
    return uniqueSlug(slugify(base), async (candidate) => {
      const clash = await this.prisma.category.findFirst({
        where: {
          ...this.notDeleted,
          parentId,
          slug: candidate,
          ...(excludeId ? { NOT: { id: excludeId } } : {}),
        },
        select: { id: true },
      });
      return clash !== null;
    });
  }
}
