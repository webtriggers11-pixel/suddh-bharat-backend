import { Body, Controller, Get, Put } from '@nestjs/common';
import { Role } from '@prisma/client';
import { Roles } from '../auth/decorators/roles.decorator';
import { StoreSettingsService } from './store-settings.service';
import { UpdateStoreSettingsDto } from './dto/store-settings.dto';

/** Store settings management (spec 08). ADMIN/SUPERADMIN only. */
@Roles(Role.ADMIN, Role.SUPERADMIN)
@Controller('admin/store-settings')
export class StoreSettingsController {
  constructor(private readonly settings: StoreSettingsService) {}

  @Get()
  get() {
    return this.settings.get();
  }

  @Put()
  update(@Body() dto: UpdateStoreSettingsDto) {
    return this.settings.update(dto);
  }
}
