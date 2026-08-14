import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsArray, IsInt, IsString, Min, ValidateNested } from 'class-validator';

export class MergeCartItemDto {
  @ApiProperty({ description: 'Id biến thể sản phẩm (ProductVariant)' })
  @IsString()
  productVariantId!: string;

  @ApiProperty({ minimum: 1 })
  @IsInt()
  @Min(1)
  quantity!: number;
}

export class MergeCartDto {
  @ApiProperty({
    type: [MergeCartItemDto],
    description:
      'Giỏ hàng khách lưu ở localStorage, gửi lên ngay sau khi đăng nhập thành công',
  })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => MergeCartItemDto)
  items!: MergeCartItemDto[];
}
