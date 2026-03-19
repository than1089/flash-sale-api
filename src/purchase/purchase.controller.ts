import {
  Controller,
  Post,
  Get,
  Body,
  Query,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiQuery } from '@nestjs/swagger';
import { PurchaseService } from './purchase.service';
import { AttemptPurchaseDto } from './dto/attempt-purchase.dto';

@ApiTags('purchases')
@Controller('purchases')
export class PurchaseController {
  constructor(private readonly purchaseService: PurchaseService) {}

  /**
   * Attempt to purchase an item in an active flash sale.
   * Returns 201 on success, or an appropriate error if the sale is inactive,
   * inventory is exhausted, or the user has already purchased.
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Attempt to purchase a flash sale item' })
  @ApiResponse({ status: 201, description: 'Purchase confirmed' })
  @ApiResponse({ status: 400, description: 'Sale not started yet' })
  @ApiResponse({ status: 409, description: 'User already purchased' })
  @ApiResponse({ status: 410, description: 'Sold out or sale ended' })
  attemptPurchase(@Body() dto: AttemptPurchaseDto) {
    return this.purchaseService.attemptPurchase(dto);
  }

  /**
   * List all confirmed purchases secured by a specific user.
   */
  @Get()
  @ApiOperation({ summary: 'List all purchases secured by a user' })
  @ApiQuery({
    name: 'userEmail',
    required: true,
    description: 'Email of the user',
  })
  @ApiResponse({
    status: 200,
    schema: {
      example: [
        {
          id: 'uuid',
          userEmail: 'alice@example.com',
          flashSaleId: 'uuid',
          status: 'confirmed',
          createdAt: '2026-03-18T10:05:00.000Z',
        },
      ],
    },
  })
  getUserPurchases(@Query('userEmail') userEmail: string) {
    return this.purchaseService.getUserPurchases(userEmail);
  }
}
