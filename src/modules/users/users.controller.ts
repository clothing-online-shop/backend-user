import { Controller } from '@nestjs/common';
import { UsersService } from './users.service';

// TODO: implement users endpoints in a later sprint
@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}
}
