import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { OrderStatus } from '@prisma/client';
import { IsEnum, IsOptional, IsString } from 'class-validator';

export class NotifyOrderStatusDto {
  @ApiProperty({
    enum: OrderStatus,
    description: 'Trạng thái đơn vừa được đổi sang',
  })
  @IsEnum(OrderStatus)
  status!: OrderStatus;

  @ApiPropertyOptional({
    description:
      'Ghi chú/lý do đổi trạng thái (vd lý do hủy đơn) — hiện trong email nếu có',
  })
  @IsOptional()
  @IsString()
  note?: string | null;
}
