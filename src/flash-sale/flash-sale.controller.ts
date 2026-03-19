import {
  Controller,
  Get,
  Post,
  Body,
  HttpCode,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiHeader } from '@nestjs/swagger';
import { FlashSaleService } from './flash-sale.service';
import { CreateFlashSaleDto } from './dto/create-flash-sale.dto';
import { ApiKeyGuard } from '../auth/api-key.guard';

@ApiTags('flash-sales')
@Controller('flash-sales')
export class FlashSaleController {
  constructor(private readonly flashSaleService: FlashSaleService) {}

  /**
   * Create a new flash sale. In production this would be admin-only.
   */
  @Post()
  @UseGuards(ApiKeyGuard)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a flash sale. For Admin only' })
  @ApiHeader({
    name: 'x-api-key',
    description: 'Admin API key',
    required: true,
  })
  @ApiResponse({ status: 201, description: 'Flash sale created' })
  @ApiResponse({ status: 401, description: 'Invalid API key' })
  create(@Body() dto: CreateFlashSaleDto) {
    return this.flashSaleService.create(dto);
  }

  /**
   * Check the current status of the flash sale.
   * Returns upcoming / active / ended along with remaining inventory.
   */
  @Get('status')
  @ApiOperation({ summary: 'Get flash sale status' })
  @ApiResponse({
    status: 200,
    description: 'Returns the most relevant flash sale and its status',
    schema: {
      example: {
        id: 'uuid',
        productName: 'Limited Edition Sneakers',
        price: 120,
        salePrice: 79.99,
        status: 'active',
        startTime: '2026-03-18T10:00:00.000Z',
        endTime: '2026-03-18T12:00:00.000Z',
        totalInventory: 100,
        remainingInventory: 47,
      },
    },
  })
  async getStatus() {
    const { sale, status, remainingInventory } =
      await this.flashSaleService.getMostRelevantSale();

    return {
      id: sale.id,
      productName: sale.productName,
      price: sale.price,
      salePrice: sale.salePrice,
      status,
      startTime: sale.startTime,
      endTime: sale.endTime,
      totalInventory: sale.totalInventory,
      remainingInventory,
    };
  }
}
