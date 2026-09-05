import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';

/** Moderation queue query (FEAT-024). */
export class AdminReviewQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize = 20;

  /** `pending` = awaiting approval; `approved` = live on the storefront. */
  @IsOptional()
  @IsIn(['all', 'pending', 'approved'])
  status?: 'all' | 'pending' | 'approved';

  @IsOptional()
  @IsString()
  productId?: string;
}

/** Body for the moderation approve/hide toggle. */
export class SetReviewApprovedDto {
  @IsBoolean()
  isApproved!: boolean;
}
