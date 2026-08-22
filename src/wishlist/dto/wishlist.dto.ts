import { IsNotEmpty, IsString } from 'class-validator';

/** Add a product to the wishlist ("like"). */
export class AddWishlistDto {
  @IsString()
  @IsNotEmpty()
  productId!: string;
}
