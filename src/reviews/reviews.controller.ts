import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import { Public } from '../auth/decorators/public.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/decorators/current-user.decorator';
import { ReviewsService } from './reviews.service';
import { CreateReviewDto } from './dto/review.dto';
import {
  AdminReviewQueryDto,
  SetReviewApprovedDto,
} from './dto/admin-review.dto';

@Controller('reviews')
export class ReviewsController {
  constructor(private readonly reviews: ReviewsService) {}

  /** Approved reviews for a product (public). */
  @Public()
  @Get('product/:productId')
  forProduct(@Param('productId') productId: string) {
    return this.reviews.listForProduct(productId);
  }

  /** Moderation queue (admin). Declared before `:id` routes. */
  @Roles(Role.ADMIN, Role.SUPERADMIN)
  @Get('admin/all')
  adminList(@Query() query: AdminReviewQueryDto) {
    return this.reviews.listAdmin(query);
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

  /** Approve or hide a review (admin). */
  @Roles(Role.ADMIN, Role.SUPERADMIN)
  @Patch(':id/approved')
  @HttpCode(200)
  setApproved(@Param('id') id: string, @Body() dto: SetReviewApprovedDto) {
    return this.reviews.setApproved(id, dto.isApproved);
  }

  /** Delete any review (admin). Declared before the owner-only DELETE. */
  @Roles(Role.ADMIN, Role.SUPERADMIN)
  @Delete('admin/:id')
  @HttpCode(200)
  adminRemove(@Param('id') id: string) {
    return this.reviews.removeAsAdmin(id);
  }

  /** Delete one's own review. */
  @Delete(':id')
  @HttpCode(200)
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.reviews.remove(user.id, id);
  }
}
