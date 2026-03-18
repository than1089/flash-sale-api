import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { RedisModule } from './redis/redis.module';
import { FlashSaleModule } from './flash-sale/flash-sale.module';
import { PurchaseModule } from './purchase/purchase.module';
import { FlashSale } from './flash-sale/entities/flash-sale.entity';
import { Purchase } from './purchase/entities/purchase.entity';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres',
        host: config.get<string>('DB_HOST', 'localhost'),
        port: config.get<number>('DB_PORT', 5432),
        username: config.get<string>('DB_USERNAME', 'postgres'),
        password: config.get<string>('DB_PASSWORD', 'postgres'),
        database: config.get<string>('DB_DATABASE', 'flash_sale'),
        entities: [FlashSale, Purchase],
        synchronize: true, // auto-creates tables in dev; use migrations in prod
        ssl: false,
      }),
    }),
    RedisModule,
    FlashSaleModule,
    PurchaseModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}

