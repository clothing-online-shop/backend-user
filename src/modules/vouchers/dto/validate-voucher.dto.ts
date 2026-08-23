import { ApiProperty } from '@nestjs/swagger';
import { ArrayMinSize, IsArray, IsString, MinLength } from 'class-validator';

export class ValidateVoucherDto {
  @ApiProperty({ example: 'SUMMER2026' })
  @IsString()
  @MinLength(1)
  code!: string;

  @ApiProperty({
    description: 'Danh sách id các dòng trong giỏ hàng dự kiến thanh toán',
    type: [String],
  })
  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  cartItemIds!: string[];
}
