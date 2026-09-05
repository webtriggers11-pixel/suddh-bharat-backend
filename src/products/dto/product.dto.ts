import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

/** Money fields are integer paise (ADR-0010). */
export class CreateProductDto {
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  name!: string;

  @IsOptional()
  @IsString()
  slug?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsInt()
  @Min(0)
  priceMinor!: number;

  @IsInt()
  @Min(0)
  mrpMinor!: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  stock?: number;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  images?: string[];

  @IsOptional()
  @IsString()
  categoryId?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30)
  @IsString({ each: true })
  tags?: string[];

  @IsOptional()
  @IsString()
  collection?: string;

  @IsOptional()
  @IsString()
  sku?: string;

  @IsOptional()
  @IsString()
  @MaxLength(10)
  hsnCode?: string;

  @IsOptional()
  @IsString()
  material?: string;

  @IsOptional()
  @IsString()
  color?: string;

  @IsOptional()
  @Type(() => Number)
  weightKg?: number;

  @IsOptional()
  @Type(() => Number)
  lengthCm?: number;

  @IsOptional()
  @Type(() => Number)
  breadthCm?: number;

  @IsOptional()
  @Type(() => Number)
  heightCm?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsBoolean()
  isHandmade?: boolean;

  @IsOptional()
  @IsBoolean()
  isFeatured?: boolean;

  @IsOptional()
  @IsBoolean()
  isNew?: boolean;

  @IsOptional()
  @IsBoolean()
  isBestseller?: boolean;
}

export class UpdateProductDto extends CreateProductDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  declare name: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  declare priceMinor: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  declare mrpMinor: number;
}

const asBool = ({ value }: { value: unknown }) =>
  value === true || value === 'true' || value === '1';

export class ProductQueryDto {
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

  @IsOptional()
  @IsString()
  categoryId?: string;

  @IsOptional()
  @IsString()
  categorySlug?: string;

  @IsOptional()
  @IsString()
  subcategorySlug?: string;

  @IsOptional()
  @Transform(asBool)
  isFeatured?: boolean;

  @IsOptional()
  @Transform(asBool)
  isNew?: boolean;

  @IsOptional()
  @Transform(asBool)
  isBestseller?: boolean;

  @IsOptional()
  @IsString()
  collection?: string;

  @IsOptional()
  @Type(() => Number)
  @Min(0)
  priceMin?: number;

  @IsOptional()
  @Type(() => Number)
  @Min(0)
  priceMax?: number;

  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @IsIn(['price_asc', 'price_desc'])
  sort?: 'price_asc' | 'price_desc';

  // Autocomplete mode: with `suggest=true` + a `search` of ≥2 chars, the list
  // endpoint returns { products, suggestions } instead of a paginated page.
  @IsOptional()
  @Transform(asBool)
  suggest?: boolean;
}

/**
 * Admin catalogue listing (BUG-002). Everything the storefront query supports,
 * plus a visibility filter — the dashboard must be able to reach products the
 * storefront deliberately hides. Kept separate from `ProductQueryDto` so the
 * public endpoint can never be asked for inactive rows.
 */
export class AdminProductQueryDto extends ProductQueryDto {
  @IsOptional()
  @IsIn(['all', 'active', 'inactive'])
  status?: 'all' | 'active' | 'inactive';
}

/** Body for the products row toggle (FEAT-020). */
export class SetProductActiveDto {
  @IsBoolean()
  isActive!: boolean;
}
