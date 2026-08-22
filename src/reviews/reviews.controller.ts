import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import { Public } from '../auth/decorators/public.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/decorators/current-user.decorator';
import { ReviewsService } from './reviews.service';
import { CreateReviewDto } from './dto/review.dto';

@Controller('reviews')
export class ReviewsController {
  constructor(private readonly reviews: ReviewsService) {}

  /** Approved reviews for a product (public). */
  @Public()
  @Get('product/:productId')
  forProduct(@Param('productId') productId: string) {
    return this.reviews.listForProduct(productId);
  }

  /** The current user's own reviews. */
  @Get('me')
  mine(@CurrentUser() user: AuthUser) {
    return this.reviews.listMine(user.id);
  }

  /** Write a review. 201. */
  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateReviewDto) {
    return this.reviews.create(user.id, dto);
  }

  /** Approve a review + recompute product rating (admin). */
  @Roles(Role.ADMIN, Role.SUPERADMIN)
  @Patch(':id/approve')
  @HttpCode(200)
  approve(@Param('id') id: string) {
    return this.reviews.approve(id);
  }

  /** Delete one's own review. */
  @Delete(':id')
  @HttpCode(200)
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.reviews.remove(user.id, id);
  }
}
