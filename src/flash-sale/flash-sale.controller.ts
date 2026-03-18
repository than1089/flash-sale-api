import { Controller, Get, Post, Body, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { FlashSaleService } from './flash-sale.service';
import { CreateFlashSaleDto } from './dto/create-flash-sale.dto';

@ApiTags('flash-sales')
@Controller('flash-sales')
export class FlashSaleController {
  constructor(private readonly flashSaleService: FlashSaleService) {}

  /**
   * Create a new flash sale. In production this would be admin-only.
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a flash sale' })
  @ApiResponse({ status: 201, description: 'Flash sale created' })
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
      status,
      startTime: sale.startTime,
      endTime: sale.endTime,
      totalInventory: sale.totalInventory,
      remainingInventory,
    };
  }
}
