import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import { Roles } from '../auth/decorators/roles.decorator';
import { ShippingConfigsService } from './shipping-configs.service';
import {
  CreateShippingConfigDto,
  RegisterWebhookDto,
  UpdateShippingConfigDto,
} from './dto/shipping-config.dto';

/** Shipping provider management (spec 10). ADMIN/SUPERADMIN only. */
@Roles(Role.ADMIN, Role.SUPERADMIN)
@Controller('admin/shipping-configs')
export class ShippingConfigsController {
  constructor(private readonly configs: ShippingConfigsService) {}

  @Get()
  list() {
    return this.configs.list();
  }

  @Post()
  create(@Body() dto: CreateShippingConfigDto) {
    return this.configs.create(dto);
  }

  @Put(':id')
  update(@Param('id') id: string, @Body() dto: UpdateShippingConfigDto) {
    return this.configs.update(id, dto);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.configs.remove(id);
  }

  @Post(':id/test')
  test(@Param('id') id: string) {
    return this.configs.testConnection(id);
  }

  @Post(':id/sync-pickup')
  syncPickup(@Param('id') id: string) {
    return this.configs.syncPickup(id);
  }

  @Post(':id/register-webhook')
  registerWebhook(@Param('id') id: string, @Body() dto: RegisterWebhookDto) {
    return this.configs.registerWebhook(id, dto);
  }
}
