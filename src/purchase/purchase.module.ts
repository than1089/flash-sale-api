import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Purchase } from './entities/purchase.entity';
import { PurchaseService } from './purchase.service';
import { PurchaseController } from './purchase.controller';
import { FlashSaleModule } from '../flash-sale/flash-sale.module';

@Module({
  imports: [TypeOrmModule.forFeature([Purchase]), FlashSaleModule],
  controllers: [PurchaseController],
  providers: [PurchaseService],
})
export class PurchaseModule {}
