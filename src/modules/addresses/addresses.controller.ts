import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import { AddressesService } from './addresses.service';
import { CreateAddressDto } from './dto/create-address.dto';
import { UpdateAddressDto } from './dto/update-address.dto';

@ApiTags('addresses')
@ApiBearerAuth()
@Controller('addresses')
@UseGuards(JwtAuthGuard)
export class AddressesController {
  constructor(private readonly addressesService: AddressesService) {}

  @Get()
  @ApiOperation({ summary: 'Danh sách sổ địa chỉ của tôi (mặc định lên đầu)' })
  findMyAddresses(@CurrentUser() user: AuthenticatedUser) {
    return this.addressesService.findMyAddresses(user.id);
  }

  @Post()
  @ApiOperation({
    summary: 'Thêm địa chỉ mới (địa chỉ đầu tiên tự động là mặc định)',
  })
  createAddress(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateAddressDto,
  ) {
    return this.addressesService.createAddress(user.id, dto);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Cập nhật thông tin địa chỉ (không đổi mặc định ở đây)',
  })
  updateAddress(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateAddressDto,
  ) {
    return this.addressesService.updateAddress(user.id, id, dto);
  }

  @Patch(':id/default')
  @ApiOperation({ summary: 'Đặt địa chỉ này làm mặc định' })
  setDefault(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.addressesService.setDefault(user.id, id);
  }

  @Delete(':id')
  @ApiOperation({
    summary:
      'Xóa địa chỉ (nếu xóa địa chỉ mặc định, tự gán địa chỉ khác làm mặc định mới)',
  })
  async deleteAddress(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    await this.addressesService.deleteAddress(user.id, id);
    return { message: 'Đã xóa địa chỉ.' };
  }
}
