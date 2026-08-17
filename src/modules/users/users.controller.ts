import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { UsersService } from './users.service';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { RequestEmailChangeDto } from './dto/request-email-change.dto';
import { ConfirmEmailChangeDto } from './dto/confirm-email-change.dto';
import { RequestPhoneChangeDto } from './dto/request-phone-change.dto';
import { ConfirmPhoneChangeDto } from './dto/confirm-phone-change.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/strategies/jwt.strategy';

@ApiTags('users')
@ApiBearerAuth()
@Controller('users/me')
@UseGuards(JwtAuthGuard)
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get()
  @ApiOperation({ summary: 'Xem hồ sơ cá nhân (SĐT hiển thị ẩn 1 phần)' })
  getProfile(@CurrentUser() user: AuthenticatedUser) {
    return this.usersService.getProfile(user.id);
  }

  @Patch()
  @ApiOperation({
    summary:
      'Cập nhật họ tên/ngày sinh/giới tính/avatar (không đổi email/SĐT ở đây)',
  })
  updateProfile(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateProfileDto,
  ) {
    return this.usersService.updateProfile(user.id, dto);
  }

  @Post('password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Đổi mật khẩu (yêu cầu mật khẩu hiện tại)' })
  changePassword(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ChangePasswordDto,
  ) {
    return this.usersService.changePassword(user.id, dto);
  }

  @Post('email/request-change')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Gửi OTP xác thực tới email mới trước khi đổi' })
  requestEmailChange(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: RequestEmailChangeDto,
  ) {
    return this.usersService.requestEmailChange(user.id, dto.newEmail);
  }

  @Post('email/confirm-change')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Xác nhận OTP để đổi sang email mới' })
  confirmEmailChange(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ConfirmEmailChangeDto,
  ) {
    return this.usersService.confirmEmailChange(
      user.id,
      dto.newEmail,
      dto.code,
    );
  }

  @Post('phone/request-change')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Gửi OTP xác thực đổi SĐT (gửi tới email hiện tại — chưa có hạ tầng SMS)',
  })
  requestPhoneChange(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: RequestPhoneChangeDto,
  ) {
    return this.usersService.requestPhoneChange(user.id, dto.newPhone);
  }

  @Post('phone/confirm-change')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Xác nhận OTP để đổi sang SĐT mới' })
  confirmPhoneChange(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ConfirmPhoneChangeDto,
  ) {
    return this.usersService.confirmPhoneChange(
      user.id,
      dto.newPhone,
      dto.code,
    );
  }
}
