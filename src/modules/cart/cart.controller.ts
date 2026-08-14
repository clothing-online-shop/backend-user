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
import { CartService } from './cart.service';
import { AddCartItemDto } from './dto/add-cart-item.dto';
import { UpdateCartItemDto } from './dto/update-cart-item.dto';
import { MergeCartDto } from './dto/merge-cart.dto';

@ApiTags('cart')
@ApiBearerAuth()
@Controller('cart')
@UseGuards(JwtAuthGuard)
export class CartController {
  constructor(private readonly cartService: CartService) {}

  @Get()
  @ApiOperation({ summary: 'Giỏ hàng của tôi (kèm tạm tính)' })
  findMyCart(@CurrentUser() user: AuthenticatedUser) {
    return this.cartService.findMyCart(user.id);
  }

  @Post('items')
  @ApiOperation({
    summary: 'Thêm sản phẩm (theo biến thể) vào giỏ, cộng dồn nếu đã có',
  })
  addItem(@CurrentUser() user: AuthenticatedUser, @Body() dto: AddCartItemDto) {
    return this.cartService.addItem(user.id, dto);
  }

  @Patch('items/:itemId')
  @ApiOperation({ summary: 'Cập nhật số lượng 1 dòng trong giỏ' })
  updateItem(
    @CurrentUser() user: AuthenticatedUser,
    @Param('itemId') itemId: string,
    @Body() dto: UpdateCartItemDto,
  ) {
    return this.cartService.updateItem(user.id, itemId, dto);
  }

  @Delete('items/:itemId')
  @ApiOperation({ summary: 'Xóa 1 dòng khỏi giỏ' })
  removeItem(
    @CurrentUser() user: AuthenticatedUser,
    @Param('itemId') itemId: string,
  ) {
    return this.cartService.removeItem(user.id, itemId);
  }

  @Post('merge')
  @ApiOperation({
    summary:
      'Gộp giỏ hàng khách (localStorage) vào giỏ tài khoản ngay sau khi đăng nhập',
  })
  mergeCart(@CurrentUser() user: AuthenticatedUser, @Body() dto: MergeCartDto) {
    return this.cartService.mergeCart(user.id, dto);
  }
}
