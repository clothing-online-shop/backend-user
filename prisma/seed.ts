import { PrismaClient } from '@prisma/client';
import * as argon2 from 'argon2';
import { generateSlug } from '../src/common/utils/slug.util';
import { ProductStatus } from '../src/modules/products/product-status.enum';

const prisma = new PrismaClient();

const SIZES = ['S', 'M', 'L', 'XL'];
const COLORS = ['Đen', 'Trắng', 'Xanh'];

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function pickRandom<T>(items: T[], count: number): T[] {
  return [...items].sort(() => Math.random() - 0.5).slice(0, count);
}

interface CategorySeed {
  name: string;
  slug: string;
  parentId?: string;
  sortOrder: number;
}

async function upsertCategory(data: CategorySeed) {
  return prisma.category.upsert({
    where: { slug: data.slug },
    update: {},
    create: data,
  });
}

interface ProductSeed {
  name: string;
  categoryId: string;
  basePrice: number;
}

async function seedProduct(seed: ProductSeed, imageSeed: number): Promise<void> {
  const slug = generateSlug(seed.name);
  const thumbnail = `https://picsum.photos/seed/${imageSeed}/600/800`;
  const images = [
    thumbnail,
    `https://picsum.photos/seed/${imageSeed + 1}/600/800`,
    `https://picsum.photos/seed/${imageSeed + 2}/600/800`,
  ];

  const variantCount = randomInt(2, 4);
  const allCombos = SIZES.flatMap((size) => COLORS.map((color) => ({ size, color })));
  const combos = pickRandom(allCombos, variantCount);

  await prisma.product.upsert({
    where: { slug },
    update: {},
    create: {
      name: seed.name,
      slug,
      description: `${seed.name} chất liệu cao cấp, form dáng chuẩn, dễ phối đồ, phù hợp nhiều dịp trong ngày.`,
      categoryId: seed.categoryId,
      basePrice: seed.basePrice,
      status: ProductStatus.ACTIVE,
      thumbnail,
      images,
      variants: {
        create: combos.map(({ size, color }) => ({
          size,
          color,
          sku: generateSlug(`${slug}-${size}-${color}`).toUpperCase(),
          price: Math.max(seed.basePrice + randomInt(-10, 10) * 1000, 10000),
          stockQuantity: randomInt(0, 60),
          imageUrl: thumbnail,
        })),
      },
    },
  });
}

async function main() {
  console.log('Seeding admin user...');
  const adminPasswordHash = await argon2.hash('admin123');
  await prisma.user.upsert({
    where: { email: 'admin@clothing-shop.com' },
    update: {},
    create: {
      email: 'admin@clothing-shop.com',
      password: adminPasswordHash,
      fullName: 'Quản trị viên',
      role: 'ADMIN',
    },
  });

  console.log('Seeding categories...');
  const nam = await upsertCategory({ name: 'Nam', slug: 'nam', sortOrder: 1 });
  const aoNam = await upsertCategory({
    name: 'Áo nam',
    slug: 'ao-nam',
    parentId: nam.id,
    sortOrder: 1,
  });
  const quanNam = await upsertCategory({
    name: 'Quần nam',
    slug: 'quan-nam',
    parentId: nam.id,
    sortOrder: 2,
  });
  const nu = await upsertCategory({ name: 'Nữ', slug: 'nu', sortOrder: 2 });
  const aoNu = await upsertCategory({
    name: 'Áo nữ',
    slug: 'ao-nu',
    parentId: nu.id,
    sortOrder: 1,
  });
  const vayNu = await upsertCategory({
    name: 'Váy nữ',
    slug: 'vay-nu',
    parentId: nu.id,
    sortOrder: 2,
  });

  console.log('Seeding products...');
  const productSeeds: ProductSeed[] = [
    { name: 'Áo sơ mi nam trắng', categoryId: aoNam.id, basePrice: 259000 },
    { name: 'Áo thun nam basic', categoryId: aoNam.id, basePrice: 159000 },
    { name: 'Áo polo nam', categoryId: aoNam.id, basePrice: 219000 },
    { name: 'Áo khoác nam denim', categoryId: aoNam.id, basePrice: 459000 },
    { name: 'Quần jean nam slimfit', categoryId: quanNam.id, basePrice: 399000 },
    { name: 'Quần âu nam', categoryId: quanNam.id, basePrice: 349000 },
    { name: 'Quần short nam kaki', categoryId: quanNam.id, basePrice: 229000 },
    { name: 'Quần jogger nam', categoryId: quanNam.id, basePrice: 279000 },
    { name: 'Áo sơ mi nữ tay dài', categoryId: aoNu.id, basePrice: 249000 },
    { name: 'Áo thun nữ croptop', categoryId: aoNu.id, basePrice: 149000 },
    { name: 'Áo kiểu nữ công sở', categoryId: aoNu.id, basePrice: 279000 },
    { name: 'Áo len nữ cổ lọ', categoryId: aoNu.id, basePrice: 329000 },
    { name: 'Áo khoác nữ dạ', categoryId: aoNu.id, basePrice: 499000 },
    { name: 'Áo vest nữ blazer', categoryId: aoNu.id, basePrice: 549000 },
    { name: 'Váy liền nữ dự tiệc', categoryId: vayNu.id, basePrice: 459000 },
    { name: 'Váy xòe nữ công sở', categoryId: vayNu.id, basePrice: 359000 },
    { name: 'Chân váy nữ midi', categoryId: vayNu.id, basePrice: 259000 },
    { name: 'Váy maxi nữ đi biển', categoryId: vayNu.id, basePrice: 389000 },
  ];

  for (const [index, seed] of productSeeds.entries()) {
    await seedProduct(seed, 100 + index * 3);
  }

  console.log(`Đã seed xong: 1 admin, 6 danh mục, ${productSeeds.length} sản phẩm.`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
