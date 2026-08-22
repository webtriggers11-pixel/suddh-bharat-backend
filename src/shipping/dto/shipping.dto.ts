import { IsOptional, IsString, Matches } from 'class-validator';

export class RateQueryDto {
  @Matches(/^\d{6}$/, { message: 'pincode must be 6 digits' })
  pincode!: string;
}

export class EstimateQueryDto {
  @Matches(/^\d{6}$/, { message: 'pincode must be 6 digits' })
  pincode!: string;

  @IsString()
  productId!: string;
}

export class SchedulePickupDto {
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'pickupDate must be YYYY-MM-DD' })
  pickupDate?: string;
}
