import { ApiProperty } from '@nestjs/swagger';
import { ArrayMinSize, IsArray, IsString } from 'class-validator';

export class ListEligibleVouchersDto {
  @ApiProperty({
    description: 'Danh sách id các dòng trong giỏ hàng dự kiến thanh toán',
    type: [String],
  })
  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  cartItemIds!: string[];
}
