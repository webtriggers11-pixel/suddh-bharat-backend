import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import { Public } from '../auth/decorators/public.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { CategoriesService } from './categories.service';
import { CreateCategoryDto, UpdateCategoryDto } from './dto/category.dto';

/**
 * Categories API. Storefront reads are public (active-only). Writes and the
 * admin listing require ADMIN/SUPERADMIN.
 */
@Controller('categories')
export class CategoriesController {
  constructor(private readonly categories: CategoriesService) {}

  @Public()
  @Get()
  list(@Query('flat') flat?: string) {
    return flat === 'true'
      ? this.categories.flat(false)
      : this.categories.tree(false);
  }

  /** Admin: full list including inactive (for management UI). */
  @Roles(Role.ADMIN, Role.SUPERADMIN)
  @Get('admin/all')
  adminList(@Query('flat') flat?: string) {
    return flat === 'true'
      ? this.categories.flat(true)
      : this.categories.tree(true);
  }

  // Two-segment route declared before the single-segment one so it matches first.
  @Public()
  @Get(':slug/:subSlug')
  subcategory(@Param('slug') slug: string, @Param('subSlug') subSlug: string) {
    return this.categories.getSubcategory(slug, subSlug);
  }

  @Public()
  @Get(':slug')
  bySlug(@Param('slug') slug: string) {
    return this.categories.getBySlug(slug, false);
  }

  @Roles(Role.ADMIN, Role.SUPERADMIN)
  @Post()
  create(@Body() dto: CreateCategoryDto) {
    return this.categories.create(dto);
  }

  @Roles(Role.ADMIN, Role.SUPERADMIN)
  @Put(':id')
  update(@Param('id') id: string, @Body() dto: UpdateCategoryDto) {
    return this.categories.update(id, dto);
  }

  @Roles(Role.ADMIN, Role.SUPERADMIN)
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.categories.remove(id);
  }
}
