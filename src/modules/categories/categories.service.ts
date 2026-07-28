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
    const categories = await this.prisma.category.findMany({
      where: { isActive: true },
      orderBy: { sortOrder: 'asc' },
    });

    return buildTree(categories);
  }

  async findBySlug(slug: string) {
    const category = await this.prisma.category.findUnique({
      where: { slug },
      include: {
        parent: true,
        children: { orderBy: { sortOrder: 'asc' } },
      },
    });

    if (!category || !category.isActive) {
      throw new NotFoundException('Không tìm thấy danh mục');
    }

    return category;
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
