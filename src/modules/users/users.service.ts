import { Injectable } from '@nestjs/common';
import { User, UserRole } from '@prisma/client';
import { PrismaService } from '../../config/prisma.service';

export interface CreateUserInput {
  email: string;
  passwordHash: string;
  fullName: string;
  phone?: string;
  role?: UserRole;
}

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  findByEmail(email: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { email } });
  }

  findById(id: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { id } });
  }

  create(input: CreateUserInput): Promise<User> {
    return this.prisma.user.create({
      data: {
        email: input.email,
        password: input.passwordHash,
        fullName: input.fullName,
        phone: input.phone,
        role: input.role ?? UserRole.CUSTOMER,
      },
    });
  }

  updatePassword(userId: string, passwordHash: string): Promise<User> {
    return this.prisma.user.update({
      where: { id: userId },
      data: { password: passwordHash },
    });
  }
}
