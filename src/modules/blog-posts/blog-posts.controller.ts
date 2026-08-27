import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { BlogPostsService } from './blog-posts.service';

@ApiTags('blog-posts')
@Controller('blog-posts')
export class BlogPostsController {
  constructor(private readonly blogPostsService: BlogPostsService) {}

  @Get('latest')
  @ApiOperation({
    summary: 'Bài viết mới nhất đã publish (public, dùng cho trang chủ)',
  })
  findLatest() {
    return this.blogPostsService.findLatest();
  }
}
