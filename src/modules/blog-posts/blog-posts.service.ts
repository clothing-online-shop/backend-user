import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../config/prisma.service';

const PUBLIC_BLOG_POST_SELECT = {
  id: true,
  title: true,
  slug: true,
  coverImage: true,
  createdAt: true,
} as const;

const LATEST_LIMIT = 3;

@Injectable()
export class BlogPostsService {
  constructor(private readonly prisma: PrismaService) {}

  // Chỉ trả bài đã publish, mới nhất trước — dùng cho khối "bài viết" ở trang chủ.
  findLatest() {
    return this.prisma.blogPost.findMany({
      where: { isPublished: true },
      orderBy: { createdAt: 'desc' },
      take: LATEST_LIMIT,
      select: PUBLIC_BLOG_POST_SELECT,
    });
  }
}
