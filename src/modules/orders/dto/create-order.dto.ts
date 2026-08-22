import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsString } from 'class-validator';

export const CheckoutPaymentMethod = {
  COD: 'COD',
  VNPAY: 'VNPAY',
  BANK_TRANSFER: 'BANK_TRANSFER',
} as const;
export type CheckoutPaymentMethod =
  (typeof CheckoutPaymentMethod)[keyof typeof CheckoutPaymentMethod];

export class CreateOrderDto {
  @ApiProperty({ description: 'Id địa chỉ giao hàng (GET /addresses)' })
  @IsString()
  addressId: string;

  @ApiProperty({ enum: CheckoutPaymentMethod })
  @IsEnum(CheckoutPaymentMethod)
  paymentMethod: CheckoutPaymentMethod;
}
