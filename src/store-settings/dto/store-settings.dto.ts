import { IsBoolean, IsInt, IsOptional, Min } from 'class-validator';

/** Editable order/payment policy. Money is integer paise (`*Minor`). */
export class UpdateStoreSettingsDto {
  @IsOptional()
  @IsBoolean()
  codEnabled?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  codChargeMinor?: number;

  // null clears the threshold (free shipping never applies).
  @IsOptional()
  @IsInt()
  @Min(0)
  freeShippingThresholdMinor?: number | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  minOrderMinor?: number;
}
