import { Injectable, NotFoundException } from '@nestjs/common';
import { Category } from '@prisma/client';
import { PrismaService } from '../../config/prisma.service';

export interface CategoryTreeNode extends Category {
  children: CategoryTreeNode[];
}

@Injectable()
export class CategoriesService {
  constructor(private readonly prisma: PrismaService) {}

  async findTree(): Promise<CategoryTreeNode[]> {
    // Lấy toàn bộ cây (kể cả danh mục ẩn) rồi mới prune, vì lọc isActive ngay ở
    // query sẽ làm mất thông tin "cha bị ẩn" — khiến con của danh mục ẩn bị coi
    // là root thay vì bị ẩn theo cha (bug đã gặp: prune sau khi dựng cây đầy đủ
    // mới cascade đúng, không có cách nào lọc đúng ngay tại query).
    const categories = await this.prisma.category.findMany({
      orderBy: { sortOrder: 'asc' },
    });

    return pruneInactive(buildTree(categories));
  }

  async findBySlug(slug: string) {
    const category = await this.prisma.category.findUnique({
      where: { slug },
      include: {
        parent: true,
        children: { where: { isActive: true }, orderBy: { sortOrder: 'asc' } },
      },
    });

    if (
      !category ||
      !category.isActive ||
      !(await this.isAncestryActive(category.parentId))
    ) {
      throw new NotFoundException('Không tìm thấy danh mục');
    }

    return category;
  }

  // Ẩn danh mục cha phải ẩn luôn danh mục con (dù con vẫn isActive=true) —
  // truy cập trực tiếp bằng slug của con phải trả về NotFound giống hệt trang cây.
  private async isAncestryActive(parentId: string | null): Promise<boolean> {
    let cursor = parentId;
    while (cursor) {
      const parent: { isActive: boolean; parentId: string | null } | null =
        await this.prisma.category.findUnique({
          where: { id: cursor },
          select: { isActive: true, parentId: true },
        });
      if (!parent || !parent.isActive) return false;
      cursor = parent.parentId;
    }
    return true;
  }
}

function buildTree(categories: Category[]): CategoryTreeNode[] {
  const nodeMap = new Map<string, CategoryTreeNode>();
  categories.forEach((c) => nodeMap.set(c.id, { ...c, children: [] }));

  const roots: CategoryTreeNode[] = [];
  for (const category of categories) {
    const node = nodeMap.get(category.id)!;
    if (category.parentId && nodeMap.has(category.parentId)) {
      nodeMap.get(category.parentId)!.children.push(node);
    } else {
      roots.push(node);
    }
  }

  return roots;
}

function pruneInactive(nodes: CategoryTreeNode[]): CategoryTreeNode[] {
  return nodes
    .filter((node) => node.isActive)
    .map((node) => ({ ...node, children: pruneInactive(node.children) }));
}
