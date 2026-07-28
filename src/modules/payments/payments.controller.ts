import { Controller } from '@nestjs/common';
import { PaymentsService } from './payments.service';

// TODO: implement payments endpoints in a later sprint
@Controller('payments')
export class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}
}
