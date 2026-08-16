import { ApiProperty } from '@nestjs/swagger';
import { IsString } from 'class-validator';

export class RecordViewDto {
  @ApiProperty({ description: 'Id sản phẩm (Product)' })
  @IsString()
  productId!: string;
}
