import { Body, Controller, Get, Patch } from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/decorators/current-user.decorator';
import { UsersService } from './users.service';
import { UpdateProfileDto } from './dto/update-profile.dto';

/** Current-user profile. Requires a valid access token (global JwtAuthGuard). */
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get('me')
  async me(@CurrentUser() user: AuthUser) {
    const found = await this.users.findById(user.id);
    return found ? UsersService.toPublic(found) : null;
  }

  @Patch('me')
  async updateMe(@CurrentUser() user: AuthUser, @Body() dto: UpdateProfileDto) {
    const updated = await this.users.updateProfile(user.id, dto);
    return UsersService.toPublic(updated);
  }
}
