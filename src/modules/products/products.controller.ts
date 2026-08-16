import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ProductsService } from './products.service';
import { ListProductsQueryDto } from './dto/list-products-query.dto';
import { AutocompleteQueryDto } from './dto/autocomplete-query.dto';
import { CompareProductsDto } from './dto/compare-products.dto';

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

  // Đặt trước @Get(':slug') — nếu để sau, request tới /products/autocomplete
  // sẽ bị Nest match nhầm vào findBySlug với slug = "autocomplete".
  @Get('autocomplete')
  @ApiOperation({
    summary:
      'Gợi ý autocomplete khi gõ tìm kiếm (chỉ trả kết quả khi q >= 2 ký tự, tối đa 8 sản phẩm)',
  })
  @ApiQuery({ name: 'q', required: false })
  autocomplete(@Query() query: AutocompleteQueryDto) {
    return this.productsService.autocomplete(query.q);
  }

  @Post('compare')
  @ApiOperation({
    summary: 'So sánh 2-4 sản phẩm (báo lỗi 400 nếu vượt quá 4)',
  })
  compare(@Body() dto: CompareProductsDto) {
    return this.productsService.compare(dto.productIds);
  }

  @Get(':slug')
  @ApiOperation({
    summary: 'Chi tiết sản phẩm theo slug (kèm variants, sản phẩm liên quan)',
  })
  findBySlug(@Param('slug') slug: string) {
    return this.productsService.findBySlug(slug);
  }
}
