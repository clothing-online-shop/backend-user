import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ProductsService } from './products.service';
import { ListProductsQueryDto } from './dto/list-products-query.dto';

@ApiTags('products')
@Controller('products')
export class ProductsController {
  constructor(private readonly productsService: ProductsService) {}

  @Get()
  @ApiOperation({
    summary:
      'Danh sách sản phẩm (filter/sort/phân trang) — chỉ trả sản phẩm ACTIVE',
  })
  @ApiQuery({
    name: 'category',
    required: false,
    description: 'Slug hoặc id danh mục',
  })
  @ApiQuery({ name: 'minPrice', required: false, type: Number })
  @ApiQuery({ name: 'maxPrice', required: false, type: Number })
  @ApiQuery({
    name: 'size',
    required: false,
    description:
      'Có thể truyền nhiều giá trị cách nhau bởi dấu phẩy, ví dụ: S,M',
  })
  @ApiQuery({
    name: 'color',
    required: false,
    description: 'Có thể truyền nhiều giá trị cách nhau bởi dấu phẩy',
  })
  @ApiQuery({ name: 'search', required: false })
  @ApiQuery({
    name: 'sort',
    required: false,
    enum: ['price_asc', 'price_desc', 'newest', 'best_selling'],
  })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiResponse({
    status: 200,
    description: 'Danh sách sản phẩm kèm meta phân trang',
  })
  findAll(@Query() query: ListProductsQueryDto) {
    return this.productsService.findAll(query);
  }

  @Get(':slug')
  @ApiOperation({
    summary: 'Chi tiết sản phẩm theo slug (kèm variants, sản phẩm liên quan)',
  })
  findBySlug(@Param('slug') slug: string) {
    return this.productsService.findBySlug(slug);
  }
}
