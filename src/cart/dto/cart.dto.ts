import { IsInt, IsString, Max, Min } from 'class-validator';

// Sane per-line ceiling — blocks absurd quantities that inflate totals / writes.
const MAX_QTY = 100;

export class AddToCartDto {
  @IsString()
  productId!: string;

  @IsInt()
  @Min(1)
  @Max(MAX_QTY)
  quantity = 1;
}

export class UpdateCartDto {
  @IsInt()
  @Min(1)
  @Max(MAX_QTY)
  quantity!: number;
}
