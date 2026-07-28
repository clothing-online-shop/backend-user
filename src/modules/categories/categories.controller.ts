import { Controller, Get, Param } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CategoriesService } from './categories.service';

@ApiTags('categories')
@Controller('categories')
export class CategoriesController {
  constructor(private readonly categoriesService: CategoriesService) {}

  @Get()
  @ApiOperation({ summary: 'Lấy cây danh mục (chỉ danh mục đang active)' })
  @ApiResponse({ status: 200, description: 'Cây danh mục (nested children)' })
  findTree() {
    return this.categoriesService.findTree();
  }

  @Get(':slug')
  @ApiOperation({ summary: 'Chi tiết 1 danh mục theo slug (chỉ nếu active)' })
  findBySlug(@Param('slug') slug: string) {
    return this.categoriesService.findBySlug(slug);
  }
}
