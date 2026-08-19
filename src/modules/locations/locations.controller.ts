import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { LocationsService } from './locations.service';
import { ListDistrictsQueryDto } from './dto/list-districts-query.dto';
import { ListWardsQueryDto } from './dto/list-wards-query.dto';

@ApiTags('locations')
@Controller('locations')
export class LocationsController {
  constructor(private readonly locationsService: LocationsService) {}

  @Get('provinces')
  @ApiOperation({ summary: 'Danh sách tỉnh/thành phố' })
  findProvinces() {
    return this.locationsService.findProvinces();
  }

  @Get('districts')
  @ApiOperation({ summary: 'Danh sách quận/huyện theo tỉnh/thành phố' })
  findDistricts(@Query() query: ListDistrictsQueryDto) {
    return this.locationsService.findDistricts(query.provinceId);
  }

  @Get('wards')
  @ApiOperation({ summary: 'Danh sách phường/xã theo quận/huyện' })
  findWards(@Query() query: ListWardsQueryDto) {
    return this.locationsService.findWards(query.districtId);
  }
}
