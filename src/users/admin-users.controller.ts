import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import { Roles } from '../auth/decorators/roles.decorator';
import { UsersService } from './users.service';
import {
  AdminUserQueryDto,
  CreateAdminDto,
  SetActiveDto,
} from './dto/admin-users.dto';

/**
 * Admin user management (spec 06). Listing is open to ADMIN/SUPERADMIN;
 * mutations (create admin, activate/deactivate) are SUPERADMIN-only.
 */
@Controller('admin/users')
export class AdminUsersController {
  constructor(private readonly users: UsersService) {}

  @Roles(Role.ADMIN, Role.SUPERADMIN)
  @Get()
  list(@Query() query: AdminUserQueryDto) {
    return this.users.adminList(query);
  }

  @Roles(Role.SUPERADMIN)
  @Post()
  createAdmin(@Body() dto: CreateAdminDto) {
    return this.users.createAdmin(dto);
  }

  @Roles(Role.SUPERADMIN)
  @Patch(':id/active')
  setActive(@Param('id') id: string, @Body() dto: SetActiveDto) {
    return this.users.setActive(id, dto.isActive);
  }
}
