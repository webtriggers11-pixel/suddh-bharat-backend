import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

export class BulkUploadDto {
  // Raw CSV text (the dashboard reads the chosen file and posts its contents).
  @IsString()
  @MaxLength(5_000_000) // ~5 MB guard, mirrors the UI limit
  content!: string;

  @IsOptional()
  @IsBoolean()
  dryRun?: boolean;
}
