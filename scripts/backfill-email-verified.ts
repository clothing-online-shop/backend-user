// Chạy tay 1 lần khi deploy thay đổi "login bắt buộc email đã verify": các tài khoản tạo
// trước đây có emailVerifiedAt = null nhưng vẫn đang dùng bình thường -> coi như đã verify
// (set = createdAt). Đồng thời lowercase email để khớp chuẩn hóa mới.
//   pnpm --filter @clothing-shop/be backfill:email-verified
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const users = await prisma.user.findMany({
    where: { status: 'ACTIVE', emailVerifiedAt: null },
    select: { id: true, email: true, createdAt: true },
  });

  let done = 0;
  let skipped = 0;
  for (const u of users) {
    const normalized = u.email.trim().toLowerCase();
    try {
      await prisma.user.update({
        where: { id: u.id },
        data: { emailVerifiedAt: u.createdAt, email: normalized },
      });
      done += 1;
    } catch {
      // Lowercase gây trùng với 1 email khác (2 tài khoản chỉ khác hoa/thường) — bỏ qua,
      // xử lý tay sau. Vẫn set verify (không đổi email) để không khoá tài khoản.
      await prisma.user.update({
        where: { id: u.id },
        data: { emailVerifiedAt: u.createdAt },
      });
      skipped += 1;
      console.warn(
        `Email không lowercase được (trùng): ${u.email} — chỉ set verified.`,
      );
    }
  }

  console.log(
    `Backfill xong: ${done} cập nhật đầy đủ, ${skipped} chỉ set verified.`,
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
