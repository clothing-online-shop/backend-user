import { ApiProperty } from '@nestjs/swagger';
import { PaymentProvider } from '@prisma/client';
import { ArrayMinSize, IsArray, IsEnum, IsString } from 'class-validator';

export class CreateOrderDto {
  @ApiProperty({ description: 'Id địa chỉ giao hàng đã lưu trong sổ địa chỉ' })
  @IsString()
  addressId!: string;

  @ApiProperty({
    description: 'Danh sách id các dòng trong giỏ hàng muốn thanh toán',
    type: [String],
  })
  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  cartItemIds!: string[];

  @ApiProperty({
    enum: PaymentProvider,
    description:
      'Phương thức thanh toán: COD (thanh toán khi nhận hàng), VNPAY (chuyển khoản qua VNPay), MOMO/STRIPE (thanh toán online). Chưa tích hợp cổng thanh toán thật — đơn được lưu với phương thức đã chọn, paymentStatus giữ mặc định UNPAID.',
  })
  @IsEnum(PaymentProvider)
  paymentMethod!: PaymentProvider;
}
