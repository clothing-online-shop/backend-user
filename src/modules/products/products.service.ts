import { Injectable, NotFoundException } from '@nestjs/common';
import { OrderStatus, Prisma, Product, ProductVariant } from '@prisma/client';
import { PrismaService } from '../../config/prisma.service';
import { ProductStatus } from './product-status.enum';
import {
  ListProductsQueryDto,
  ProductSort,
} from './dto/list-products-query.dto';

type ProductWithStockVariants = Product & {
  variants: { stockQuantity: number; color: string; size: string }[];
  brand?: { name: string } | null;
};

const RELATED_PRODUCTS_LIMIT = 8;
const DEFAULT_PAGE_LIMIT = 20;
const AUTOCOMPLETE_LIMIT = 8;

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

    if (query.brand) {
      where.brandId = { in: query.brand.split(',') };
    }

    // Giữ where trước khi gắn điều kiện search để nhánh fuzzy fallback bên dưới
    // tái dùng đúng các filter category/price/size/color, không lặp lại logic.
    const baseWhere: Prisma.ProductWhereInput = { ...where };

    if (query.search) {
      where.OR = [
        { name: { contains: query.search, mode: 'insensitive' } },
        { description: { contains: query.search, mode: 'insensitive' } },
        { brand: { name: { contains: query.search, mode: 'insensitive' } } },
      ];
    }

    const [products, total] = await this.prisma.$transaction([
      this.prisma.product.findMany({
        where,
        orderBy: resolveOrderBy(query.sort),
        skip: (page - 1) * limit,
        take: limit,
        include: {
          variants: {
            select: { stockQuantity: true, color: true, size: true },
          },
          brand: { select: { name: true } },
        },
      }),
      this.prisma.product.count({ where }),
    ]);

    // Không khớp chính xác/substring ở tên-mô tả-thương hiệu -> thử tìm gần đúng
    // (fuzzy, chịu được gõ sai/thiếu dấu) trước khi kết luận không có kết quả.
    if (query.search && total === 0) {
      return this.findAllFuzzy(query.search, baseWhere, page, limit);
    }

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

  private async findAllFuzzy(
    term: string,
    baseWhere: Prisma.ProductWhereInput,
    page: number,
    limit: number,
  ) {
    // word_similarity (không phải similarity thường) — vì query search chỉ là 1 cụm
    // ngắn, cần so với "đoạn khớp tốt nhất" trong tên/mô tả/thương hiệu (vốn dài hơn
    // nhiều so với query) thay vì so toàn chuỗi, nếu không description gần như luôn
    // fail dù khớp rõ ràng (đã tự tay verify: similarity('cao cap', description dài
    // ~90 ký tự) chỉ ra ~0.08 dù cụm đó nằm nguyên trong description).
    // Ngưỡng 0.5 cho tên/thương hiệu, 0.3 cho mô tả — đã đối chiếu với data seed thật để
    // vừa bắt được case gõ không dấu phổ biến, vừa không lôi kéo quá nhiều sản phẩm
    // không liên quan chỉ vì trùng vài từ chung (vd "quần"/"nam").
    const matches = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT p.id
      FROM products p
      LEFT JOIN brands b ON b.id = p."brandId"
      WHERE p.status = ${ProductStatus.ACTIVE}
        AND (
          word_similarity(immutable_unaccent(${term}), immutable_unaccent(p.name)) > 0.5
          OR word_similarity(immutable_unaccent(${term}), immutable_unaccent(coalesce(p.description, ''))) > 0.5
          OR word_similarity(immutable_unaccent(${term}), immutable_unaccent(coalesce(b.name, ''))) > 0.5
        )
      ORDER BY GREATEST(
        word_similarity(immutable_unaccent(${term}), immutable_unaccent(p.name)),
        word_similarity(immutable_unaccent(${term}), immutable_unaccent(coalesce(p.description, ''))) * 0.8,
        word_similarity(immutable_unaccent(${term}), immutable_unaccent(coalesce(b.name, '')))
      ) DESC
    `;

    const orderedIds = matches.map((m) => m.id);
    if (orderedIds.length === 0) {
      return { data: [], meta: { total: 0, page, limit, totalPages: 0 } };
    }

    const products = await this.prisma.product.findMany({
      where: { ...baseWhere, id: { in: orderedIds } },
      include: {
        variants: { select: { stockQuantity: true, color: true, size: true } },
        brand: { select: { name: true } },
      },
    });

    // findMany({ id: { in } }) không giữ thứ tự -> sắp lại theo điểm similarity
    // đã tính ở query raw phía trên.
    const rank = new Map(orderedIds.map((id, index) => [id, index]));
    const sorted = [...products].sort(
      (a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0),
    );

    const total = sorted.length;
    const paged = sorted.slice((page - 1) * limit, page * limit);

    return {
      data: paged.map(toListItem),
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  async autocomplete(term?: string) {
    const q = term?.trim() ?? '';
    if (q.length < 2) return [];

    const results = await this.prisma.$queryRaw<
      {
        id: string;
        name: string;
        slug: string;
        thumbnail: string | null;
        basePrice: number;
        salePrice: number | null;
      }[]
    >`
      SELECT p.id, p.name, p.slug, p.thumbnail,
        p."basePrice"::float8 AS "basePrice",
        p."salePrice"::float8 AS "salePrice"
      FROM products p
      LEFT JOIN brands b ON b.id = p."brandId"
      WHERE p.status = ${ProductStatus.ACTIVE}
        AND (
          immutable_unaccent(p.name) ILIKE immutable_unaccent(${'%' + q + '%'})
          OR word_similarity(immutable_unaccent(${q}), immutable_unaccent(p.name)) > 0.5
          OR word_similarity(immutable_unaccent(${q}), immutable_unaccent(coalesce(b.name, ''))) > 0.5
        )
      ORDER BY
        (immutable_unaccent(p.name) ILIKE immutable_unaccent(${q + '%'})) DESC,
        word_similarity(immutable_unaccent(${q}), immutable_unaccent(p.name)) DESC
      LIMIT ${AUTOCOMPLETE_LIMIT}
    `;

    return results;
  }

  // Không persist — "so sánh" là thao tác tức thời, FE tự quản lý danh sách đang so sánh
  // (giống cách giỏ hàng khách quản lý localStorage), BE chỉ trả dữ liệu khi FE gửi id lên.
  async compare(productIds: string[]) {
    const products = await this.prisma.product.findMany({
      where: {
        id: { in: productIds },
        status: ProductStatus.ACTIVE,
      },
      include: { variants: true },
    });

    // Giữ đúng thứ tự FE gửi lên — findMany({ id: { in } }) không đảm bảo thứ tự.
    const rank = new Map(productIds.map((id, index) => [id, index]));
    const sorted = [...products].sort(
      (a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0),
    );

    return sorted.map((product) => ({
      ...toListItem(product),
      description: product.description,
      material: product.material,
      careInstructions: product.careInstructions,
      variants: product.variants.map(toVariantDto),
    }));
  }

  async findBySlug(slug: string) {
    const product = await this.prisma.product.findUnique({
      where: { slug },
      include: {
        category: true,
        variants: true,
        reviews: {
          orderBy: { createdAt: 'desc' },
          include: { user: { select: { fullName: true } } },
        },
        brand: { select: { name: true } },
      },
    });

    const status: ProductStatus | undefined = product?.status;
    if (!product || status !== ProductStatus.ACTIVE) {
      throw new NotFoundException('Không tìm thấy sản phẩm');
    }

    const [relatedProducts, ancestors, reviewCounts, soldResult] =
      await Promise.all([
        this.prisma.product.findMany({
          where: {
            categoryId: product.categoryId,
            id: { not: product.id },
            status: ProductStatus.ACTIVE,
          },
          include: {
            variants: {
              select: { stockQuantity: true, color: true, size: true },
            },
            brand: { select: { name: true } },
          },
          take: RELATED_PRODUCTS_LIMIT,
        }),
        this.resolveCategoryAncestors(product.category.parentId),
        this.prisma.review.groupBy({
          by: ['rating'],
          where: { productId: product.id },
          _count: true,
        }),
        // Chỉ tính đơn COMPLETED — "đã bán" phải là đơn thực sự hoàn tất, không tính đơn
        // đang xử lý/đã hủy. OrderItem không có productId trực tiếp (chỉ có
        // productVariantId), lọc qua quan hệ productVariant.product.
        this.prisma.orderItem.aggregate({
          where: {
            productVariant: { productId: product.id },
            order: { status: OrderStatus.COMPLETED },
          },
          _sum: { quantity: true },
        }),
      ]);

    return {
      ...toListItem(product),
      description: product.description,
      material: product.material,
      careInstructions: product.careInstructions,
      images: product.images,
      category: {
        id: product.category.id,
        name: product.category.name,
        slug: product.category.slug,
        // Từ danh mục gốc tới danh mục cha trực tiếp (không gồm chính category hiện tại)
        // — dùng để dựng breadcrumb đầy đủ nhiều cấp ở PDP.
        ancestors,
      },
      variants: product.variants.map(toVariantDto),
      reviews: product.reviews.map((review) => ({
        id: review.id,
        productId: review.productId,
        reviewerName: maskReviewerName(review.user.fullName),
        rating: review.rating,
        comment: review.comment,
        createdAt: review.createdAt,
      })),
      reviewSummary: buildReviewSummary(reviewCounts),
      soldCount: soldResult._sum.quantity ?? 0,
      relatedProducts: relatedProducts.map(toListItem),
    };
  }

  private async resolveCategoryAncestors(
    parentId: string | null,
  ): Promise<{ id: string; name: string; slug: string }[]> {
    const chain: { id: string; name: string; slug: string }[] = [];
    let cursor = parentId;

    while (cursor) {
      const parent: {
        id: string;
        name: string;
        slug: string;
        parentId: string | null;
      } | null = await this.prisma.category.findUnique({
        where: { id: cursor },
        select: { id: true, name: true, slug: true, parentId: true },
      });
      if (!parent) break;
      chain.unshift({ id: parent.id, name: parent.name, slug: parent.slug });
      cursor = parent.parentId;
    }

    return chain;
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
    brandName: product.brand?.name ?? null,
    basePrice: product.basePrice.toNumber(),
    salePrice: product.salePrice?.toNumber() ?? null,
    status: product.status,
    categoryId: product.categoryId,
    totalStock: product.variants.reduce((sum, v) => sum + v.stockQuantity, 0),
    colors: [...new Set(product.variants.map((v) => v.color))],
    sizes: [...new Set(product.variants.map((v) => v.size))],
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

// Không trả tên đầy đủ của khách ra API public — che theo kiểu "Mai N." (giữ từ cuối trong
// fullName vì người Việt xưng hô bằng tên gọi/tên đệm cuối, viết tắt chữ đầu của từ đầu tiên
// làm họ). Tên 1 từ (không có khoảng trắng) thì giữ nguyên, không có gì để viết tắt.
function maskReviewerName(fullName: string): string {
  const parts = fullName.trim().split(/\s+/);
  if (parts.length < 2) return parts[0] ?? 'Khách hàng';
  return `${parts[parts.length - 1]} ${parts[0][0].toUpperCase()}.`;
}

function buildReviewSummary(counts: { rating: number; _count: number }[]): {
  average: number;
  count: number;
  breakdown: Record<number, number>;
} {
  const breakdown: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  let total = 0;
  let weightedSum = 0;
  for (const { rating, _count } of counts) {
    breakdown[rating] = _count;
    total += _count;
    weightedSum += rating * _count;
  }
  return {
    average: total > 0 ? Math.round((weightedSum / total) * 10) / 10 : 0,
    count: total,
    breakdown,
  };
}
