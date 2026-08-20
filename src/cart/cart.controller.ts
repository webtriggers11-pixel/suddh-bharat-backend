import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
} from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/decorators/current-user.decorator';
import { CartService } from './cart.service';
import { AddToCartDto, UpdateCartDto } from './dto/cart.dto';

/** Per-user cart. All routes require a valid access token (global JwtAuthGuard). */
@Controller('cart')
export class CartController {
  constructor(private readonly cart: CartService) {}

  @Get()
  get(@CurrentUser() user: AuthUser) {
    return this.cart.summary(user.id);
  }

  @Post()
  add(@CurrentUser() user: AuthUser, @Body() dto: AddToCartDto) {
    return this.cart.add(user.id, dto.productId, dto.quantity);
  }

  @Put(':productId')
  update(
    @CurrentUser() user: AuthUser,
    @Param('productId') productId: string,
    @Body() dto: UpdateCartDto,
  ) {
    return this.cart.setQuantity(user.id, productId, dto.quantity);
  }

  @Delete(':productId')
  remove(@CurrentUser() user: AuthUser, @Param('productId') productId: string) {
    return this.cart.remove(user.id, productId);
  }

  @Delete()
  clear(@CurrentUser() user: AuthUser) {
    return this.cart.clear(user.id);
  }
}
