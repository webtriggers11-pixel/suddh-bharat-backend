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
import { PaymentGatewaysService } from './payment-gateways.service';
import {
  CreatePaymentGatewayDto,
  UpdatePaymentGatewayDto,
} from './dto/payment-gateway.dto';

/** Payment gateway management (spec 09). ADMIN/SUPERADMIN only. */
@Roles(Role.ADMIN, Role.SUPERADMIN)
@Controller('admin/payment-gateways')
export class PaymentGatewaysController {
  constructor(private readonly gateways: PaymentGatewaysService) {}

  @Get()
  list() {
    return this.gateways.list();
  }

  @Post()
  create(@Body() dto: CreatePaymentGatewayDto) {
    return this.gateways.create(dto);
  }

  @Put(':id')
  update(@Param('id') id: string, @Body() dto: UpdatePaymentGatewayDto) {
    return this.gateways.update(id, dto);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.gateways.remove(id);
  }
}
