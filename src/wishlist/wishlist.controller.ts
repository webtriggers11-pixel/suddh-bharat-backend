import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
} from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/decorators/current-user.decorator';
import { WishlistService } from './wishlist.service';
import { AddWishlistDto } from './dto/wishlist.dto';

/** Wishlist ("likes"). All routes require a valid access token. */
@Controller('wishlist')
export class WishlistController {
  constructor(private readonly wishlist: WishlistService) {}

  /** Liked products with their display snapshot, newest first. */
  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.wishlist.list(user.id);
  }

  /** Lightweight list of liked product ids (for marking hearts across the app). */
  @Get('ids')
  ids(@CurrentUser() user: AuthUser) {
    return this.wishlist.ids(user.id);
  }

  /** Like a product. 201. */
  @Post()
  add(@CurrentUser() user: AuthUser, @Body() dto: AddWishlistDto) {
    return this.wishlist.add(user.id, dto.productId);
  }

  /** Unlike a product. */
  @Delete(':productId')
  @HttpCode(200)
  remove(@CurrentUser() user: AuthUser, @Param('productId') productId: string) {
    return this.wishlist.remove(user.id, productId);
  }
}
