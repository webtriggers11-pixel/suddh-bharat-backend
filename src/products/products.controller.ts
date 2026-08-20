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
import { ProductsService } from './products.service';
import {
  CreateProductDto,
  ProductQueryDto,
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
    return this.products.list(query, false);
  }

  @Public()
  @Get(':slug')
  bySlug(@Param('slug') slug: string) {
    return this.products.getBySlug(slug, false);
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

  @Roles(Role.ADMIN, Role.SUPERADMIN)
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.products.remove(id);
  }
}
