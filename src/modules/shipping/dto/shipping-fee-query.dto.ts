import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class ShippingFeeQueryDto {
  @ApiProperty({ description: 'id địa chỉ đã lưu (GET /addresses)' })
  @IsString()
  @IsNotEmpty()
  addressId!: string;
}
