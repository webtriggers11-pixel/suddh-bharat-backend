import { Body, Controller, Get, Param, Patch, Query } from '@nestjs/common';
import { Role } from '@prisma/client';
import { Roles } from '../auth/decorators/roles.decorator';
import { OrdersService } from './orders.service';
import {
  OrderListQueryDto,
  UpdateNotesDto,
  UpdateStatusDto,
} from './dto/order.dto';

/** Admin order management + fulfilment state machine. ADMIN/SUPERADMIN only. */
@Roles(Role.ADMIN, Role.SUPERADMIN)
@Controller('admin/orders')
export class OrdersAdminController {
  constructor(private readonly orders: OrdersService) {}

  @Get()
  list(@Query() query: OrderListQueryDto) {
    return this.orders.adminList(query);
  }

  @Get(':id')
  detail(@Param('id') id: string) {
    return this.orders.adminGet(id);
  }

  @Patch(':id/status')
  updateStatus(@Param('id') id: string, @Body() dto: UpdateStatusDto) {
    return this.orders.updateStatus(id, dto);
  }

  /** PLACED → CONFIRMED (requires a valid payment). */
  @Patch(':id/confirm')
  confirm(@Param('id') id: string) {
    return this.orders.confirm(id);
  }

  /** Mark a COD payment collected → order DELIVERED. */
  @Patch(':id/confirm-cod')
  confirmCod(@Param('id') id: string) {
    return this.orders.confirmCod(id);
  }

  @Patch(':id/notes')
  notes(@Param('id') id: string, @Body() dto: UpdateNotesDto) {
    return this.orders.updateNotes(id, dto.adminNotes);
  }
}
