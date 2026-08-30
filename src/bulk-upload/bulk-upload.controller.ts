import { Body, Controller, Post, Query } from '@nestjs/common';
import { Role } from '@prisma/client';
import { Roles } from '../auth/decorators/roles.decorator';
import { BulkUploadService } from './bulk-upload.service';
import { BulkUploadDto } from './dto/bulk-upload.dto';

/** Bulk product import (spec 07). SUPER-ADMIN only. */
@Roles(Role.SUPERADMIN)
@Controller('admin/products/bulk-upload')
export class BulkUploadController {
  constructor(private readonly bulk: BulkUploadService) {}

  @Post()
  run(@Body() dto: BulkUploadDto, @Query('dryRun') dryRun?: string) {
    // Fail safe: a live import requires an explicit opt-out. If neither the
    // body nor the query param says otherwise, this previews instead of
    // writing to live products.
    const isDryRun = dto.dryRun ?? dryRun !== 'false';
    return this.bulk.run(dto.content, isDryRun);
  }
}
