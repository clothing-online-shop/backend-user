import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, Product, ProductVariant } from '@prisma/client';
import { PrismaService } from '../../config/prisma.service';
import { ProductStatus } from './product-status.enum';
import {
  ListProductsQueryDto,
  ProductSort,
} from './dto/list-products-query.dto';

type ProductWithStockVariants = Product & {
  variants: { stockQuantity: number }[];
};

const RELATED_PRODUCTS_LIMIT = 8;
const DEFAULT_PAGE_LIMIT = 20;

@Injectable()
export class ProductsService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(query: ListProductsQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? DEFAULT_PAGE_LIMIT;

    const where: Prisma.ProductWhereInput = { status: ProductStatus.ACTIVE };

    if (query.category) {
      const categoryIds = await this.resolveCategoryIds(query.category);
      if (categoryIds.length === 0) {
        return { data: [], meta: { total: 0, page, limit, totalPages: 0 } };
      }
      where.categoryId = { in: categoryIds };
    }

    if (query.minPrice !== undefined || query.maxPrice !== undefined) {
      where.basePrice = {
        ...(query.minPrice !== undefined ? { gte: query.minPrice } : {}),
        ...(query.maxPrice !== undefined ? { lte: query.maxPrice } : {}),
      };
    }

    if (query.size || query.color) {
      where.variants = {
        some: {
          ...(query.size ? { size: { in: query.size.split(',') } } : {}),
          ...(query.color ? { color: { in: query.color.split(',') } } : {}),
        },
      };
    }

    if (query.search) {
      where.name = { contains: query.search, mode: 'insensitive' };
    }

    const [products, total] = await this.prisma.$transaction([
      this.prisma.product.findMany({
        where,
        orderBy: resolveOrderBy(query.sort),
        skip: (page - 1) * limit,
        take: limit,
        include: { variants: { select: { stockQuantity: true } } },
      }),
      this.prisma.product.count({ where }),
    ]);

    return {
      data: products.map(toListItem),
      meta: {
        total,
        page,
        limit,
        totalPages: total === 0 ? 0 : Math.ceil(total / limit),
      },
    };
  }

  async findBySlug(slug: string) {
    const product = await this.prisma.product.findUnique({
      where: { slug },
      include: {
        category: true,
        variants: true,
        reviews: { orderBy: { createdAt: 'desc' } },
      },
    });

    const status: ProductStatus | undefined = product?.status;
    if (!product || status !== ProductStatus.ACTIVE) {
      throw new NotFoundException('Không tìm thấy sản phẩm');
    }

    const relatedProducts = await this.prisma.product.findMany({
      where: {
        categoryId: product.categoryId,
        id: { not: product.id },
        status: ProductStatus.ACTIVE,
      },
      include: { variants: { select: { stockQuantity: true } } },
      take: RELATED_PRODUCTS_LIMIT,
    });

    return {
      ...toListItem(product),
      description: product.description,
      images: product.images,
      category: {
        id: product.category.id,
        name: product.category.name,
        slug: product.category.slug,
      },
      variants: product.variants.map(toVariantDto),
      reviews: product.reviews,
      relatedProducts: relatedProducts.map(toListItem),
    };
  }

  private async resolveCategoryIds(slugOrId: string): Promise<string[]> {
    const category = await this.prisma.category.findFirst({
      where: { OR: [{ slug: slugOrId }, { id: slugOrId }], isActive: true },
      select: { id: true },
    });
    if (!category) return [];

    // Chỉ lấy danh mục đang hiện: cây con của 1 danh mục con đang ẩn sẽ không
    // bao giờ được nối vào childrenMap bên dưới, nên tự động không lọt sản phẩm
    // của nhánh bị ẩn ra danh sách — không cần đệ quy kiểm tra isActive thủ công.
    const all = await this.prisma.category.findMany({
      where: { isActive: true },
      select: { id: true, parentId: true },
    });
    const childrenMap = new Map<string, string[]>();
    for (const c of all) {
      if (!c.parentId) continue;
      const list = childrenMap.get(c.parentId) ?? [];
      list.push(c.id);
      childrenMap.set(c.parentId, list);
    }

    const ids: string[] = [];
    const stack = [category.id];
    while (stack.length > 0) {
      const current = stack.pop()!;
      ids.push(current);
      for (const child of childrenMap.get(current) ?? []) stack.push(child);
    }
    return ids;
  }
}

function resolveOrderBy(
  sort?: ProductSort,
): Prisma.ProductOrderByWithRelationInput {
  switch (sort) {
    case 'price_asc':
      return { basePrice: 'asc' };
    case 'price_desc':
      return { basePrice: 'desc' };
    case 'best_selling':
      // TODO: cần dữ liệu OrderItem để tính best-selling thật (Sprint 3+), tạm sort theo mới nhất
      return { createdAt: 'desc' };
    case 'newest':
    default:
      return { createdAt: 'desc' };
  }
}

function toListItem(product: ProductWithStockVariants) {
  return {
    id: product.id,
    name: product.name,
    slug: product.slug,
    thumbnail: product.thumbnail,
    basePrice: product.basePrice.toNumber(),
    status: product.status,
    categoryId: product.categoryId,
    totalStock: product.variants.reduce((sum, v) => sum + v.stockQuantity, 0),
    createdAt: product.createdAt,
  };
}

function toVariantDto(variant: ProductVariant) {
  return {
    id: variant.id,
    size: variant.size,
    color: variant.color,
    sku: variant.sku,
    price: variant.price.toNumber(),
    stockQuantity: variant.stockQuantity,
    imageUrl: variant.imageUrl,
  };
}
