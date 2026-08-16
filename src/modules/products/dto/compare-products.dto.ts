import { ApiProperty } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsString,
} from 'class-validator';

export class CompareProductsDto {
  @ApiProperty({
    type: [String],
    description: 'Danh sách id sản phẩm cần so sánh — tối thiểu 2, tối đa 4',
    minItems: 2,
    maxItems: 4,
  })
  @ArrayMinSize(2)
  @ArrayMaxSize(4)
  @ArrayUnique()
  @IsString({ each: true })
  productIds!: string[];
}
