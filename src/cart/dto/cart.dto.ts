import { IsInt, IsString, Min } from 'class-validator';

export class AddToCartDto {
  @IsString()
  productId!: string;

  @IsInt()
  @Min(1)
  quantity = 1;
}

export class UpdateCartDto {
  @IsInt()
  @Min(1)
  quantity!: number;
}
