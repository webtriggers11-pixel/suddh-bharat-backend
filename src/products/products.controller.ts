import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import { Public } from '../auth/decorators/public.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { ProductsService } from './products.service';
import {
  AdminProductQueryDto,
  CreateProductDto,
  ProductQueryDto,
  SetProductActiveDto,
  UpdateProductDto,
} from './dto/product.dto';

/**
 * Products API. Storefront reads are public (active-only). Writes require
 * ADMIN/SUPERADMIN.
 */
@Controller('products')
export class ProductsController {
  constructor(private readonly products: ProductsService) {}

  @Public()
  @Get()
  list(@Query() query: ProductQueryDto) {
    // Autocomplete mode returns { products, suggestions } instead of a page.
    if (query.suggest) return this.products.suggest(query, false);
    return this.products.list(query, false);
  }

  /**
   * Admin catalogue listing (BUG-002) — includes inactive products and the
   * admin-only columns. Declared before the `:slug` routes so 'admin' is never
   * swallowed as a slug.
   */
  @Roles(Role.ADMIN, Role.SUPERADMIN)
  @Get('admin/all')
  adminList(@Query() query: AdminProductQueryDto) {
    return this.products.listAdmin(query);
  }

  /** Admin product read by id or slug — resolves inactive products too. */
  @Roles(Role.ADMIN, Role.SUPERADMIN)
  @Get('admin/:idOrSlug')
  adminDetail(@Param('idOrSlug') idOrSlug: string) {
    return this.products.getForAdmin(idOrSlug);
  }

  @Public()
  @Get(':slug')
  bySlug(@Param('slug') slug: string) {
    return this.products.getBySlug(slug, false);
  }

  @Public()
  @Get(':slug/related')
  related(@Param('slug') slug: string) {
    return this.products.findRelated(slug);
  }

  @Roles(Role.ADMIN, Role.SUPERADMIN)
  @Post()
  create(@Body() dto: CreateProductDto) {
    return this.products.create(dto);
  }

  @Roles(Role.ADMIN, Role.SUPERADMIN)
  @Put(':id')
  update(@Param('id') id: string, @Body() dto: UpdateProductDto) {
    return this.products.update(id, dto);
  }

  /** Storefront visibility toggle for the dashboard's product row (FEAT-020). */
  @Roles(Role.ADMIN, Role.SUPERADMIN)
  @Patch(':id/active')
  setActive(@Param('id') id: string, @Body() dto: SetProductActiveDto) {
    return this.products.setActive(id, dto.isActive);
  }

  @Roles(Role.ADMIN, Role.SUPERADMIN)
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.products.remove(id);
  }
}
