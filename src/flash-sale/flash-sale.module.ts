import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { FlashSale } from './entities/flash-sale.entity';
import { FlashSaleService } from './flash-sale.service';
import { FlashSaleController } from './flash-sale.controller';
import { Purchase } from '../purchase/entities/purchase.entity';

@Module({
  imports: [TypeOrmModule.forFeature([FlashSale, Purchase])],
  controllers: [FlashSaleController],
  providers: [FlashSaleService],
  exports: [FlashSaleService],
})
export class FlashSaleModule {}
