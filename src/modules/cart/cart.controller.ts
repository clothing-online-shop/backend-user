import { Controller } from '@nestjs/common';
import { CartService } from './cart.service';

// TODO: implement cart endpoints in a later sprint
@Controller('cart')
export class CartController {
  constructor(private readonly cartService: CartService) {}
}
