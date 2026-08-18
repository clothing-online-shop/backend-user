import { User } from '@prisma/client';

// Loại field `password` trước khi trả user ra response — dùng ở mọi nơi trả User (auth,
// users self-service...), không tự viết lại rải rác.
export function toSafeUser(user: User): Omit<User, 'password'> {
  const safeUser: Partial<User> = { ...user };
  delete safeUser.password;
  return safeUser as Omit<User, 'password'>;
}
