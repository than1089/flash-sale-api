import {
  Injectable,
  NotFoundException,
  BadRequestException,
  OnModuleInit,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThanOrEqual, MoreThanOrEqual } from 'typeorm';
import { FlashSale } from './entities/flash-sale.entity';
import { CreateFlashSaleDto } from './dto/create-flash-sale.dto';
import { FlashSaleStatus } from './enums/flash-sale-status.enum';
import { RedisService } from '../redis/redis.service';
import { Purchase, PurchaseStatus } from '../purchase/entities/purchase.entity';

@Injectable()
export class FlashSaleService implements OnModuleInit {
  private readonly logger = new Logger(FlashSaleService.name);
  // Cache TTL for the flash sale metadata DB lookup (seconds).
  // Inventory is always read fresh from Redis regardless of this TTL.
  private static readonly SALE_CACHE_KEY = 'flash_sale:current:meta';
  private static readonly SALE_CACHE_TTL = 10;

  constructor(
    @InjectRepository(FlashSale)
    private readonly flashSaleRepo: Repository<FlashSale>,
    @InjectRepository(Purchase)
    private readonly purchaseRepo: Repository<Purchase>,
    private readonly redisService: RedisService,
  ) { }

  /**
   * On startup, sync Redis inventory for any sales that are currently active
   * or upcoming so Redis is not stale after a restart.
   */
  async onModuleInit(): Promise<void> {
    const now = new Date();
    const relevantSales = await this.flashSaleRepo.find({
      where: { endTime: MoreThanOrEqual(now) },
    });

    for (const sale of relevantSales) {
      const soldCount = await this.purchaseRepo.count({
        where: { flashSaleId: sale.id, status: PurchaseStatus.CONFIRMED },
      });
      const remaining = Math.max(0, sale.totalInventory - soldCount);
      await this.redisService.syncInventory(sale.id, remaining);
      this.logger.log(
        `Synced inventory for sale ${sale.id}: ${remaining} remaining`,
      );
    }
  }

  async create(dto: CreateFlashSaleDto): Promise<FlashSale> {
    const start = new Date(dto.startTime);
    const end = new Date(dto.endTime);

    if (end <= start) {
      throw new BadRequestException('endTime must be after startTime');
    }

    if (dto.salePrice > dto.price) {
      throw new BadRequestException('salePrice must be less than or equal to price');
    }

    const sale = this.flashSaleRepo.create({
      productName: dto.productName,
      price: dto.price,
      salePrice: dto.salePrice,
      startTime: start,
      endTime: end,
      totalInventory: dto.totalInventory,
    });

    const saved = await this.flashSaleRepo.save(sale);
    await this.redisService.initInventory(saved.id, saved.totalInventory);
    // Bust the metadata cache so the next status request sees the new sale
    await this.redisService.del(FlashSaleService.SALE_CACHE_KEY);
    return saved;
  }

  /**
   * Returns the most relevant single flash sale:
   * priority order — active → upcoming (soonest) → ended (most recent)
   *
   * The DB lookup is cached in Redis for SALE_CACHE_TTL seconds to reduce
   * PostgreSQL load under heavy read traffic. Inventory is always served
   * fresh directly from the Redis counter, so it is never stale.
   */
  async getMostRelevantSale(): Promise<{
    sale: FlashSale;
    status: FlashSaleStatus;
    remainingInventory: number;
  }> {
    // --- Cache layer: try Redis first ---
    let sale = await this.redisService.getJson<FlashSale>(
      FlashSaleService.SALE_CACHE_KEY,
    );

    if (!sale) {
      sale = await this.getMostRelevantSaleFromDb();

      // Store in cache; intentionally fire-and-forget so a Redis hiccup
      // never blocks the response.
      this.redisService
        .setJson(FlashSaleService.SALE_CACHE_KEY, sale, FlashSaleService.SALE_CACHE_TTL)
        .catch((err) => this.logger.warn('Failed to cache sale metadata', err));
    }

    // Inventory is always read fresh from its own Redis key — never cached here
    const remainingInventory = await this.getInventory(sale);
    const status = this.computeStatus(sale, remainingInventory);

    return { sale, status, remainingInventory };
  }

  async findById(id: string): Promise<FlashSale> {
    const sale = await this.flashSaleRepo.findOne({ where: { id } });
    if (!sale) throw new NotFoundException(`Flash sale ${id} not found`);
    return sale;
  }

  private computeStatus(sale: FlashSale, remainingInventory: number): FlashSaleStatus {
    const now = new Date();
    if (now < sale.startTime) return FlashSaleStatus.UPCOMING;
    if (now > sale.endTime || remainingInventory <= 0)
      return FlashSaleStatus.ENDED;
    return FlashSaleStatus.ACTIVE;
  }

  private async getMostRelevantSaleFromDb(): Promise<FlashSale> {
    const now = new Date();
    // Priority 1: active sales
    let sale = await this.flashSaleRepo.findOne({
      where: {
        startTime: LessThanOrEqual(now),
        endTime: MoreThanOrEqual(now),
      },
      order: { startTime: 'DESC' },
    });

    // Priority 2: upcoming sales (soonest)
    if (!sale) {
      sale = await this.flashSaleRepo.findOne({
        where: { startTime: MoreThanOrEqual(now) },
        order: { startTime: 'ASC' },
      });
    }

    // Priority 3: ended sales (most recent)
    if (!sale) {
      sale = await this.flashSaleRepo.findOne({
        where: { endTime: LessThanOrEqual(now) },
        order: { endTime: 'DESC' },
      });
    }

    if (!sale) {
      throw new NotFoundException('No flash sale found');
    }
    return sale;
  }

  private async getInventory(sale: FlashSale): Promise<number> {
    const cached = await this.redisService.getRemainingInventory(sale.id);
    if (cached !== null) return cached;

    // Redis miss — fall back to DB count
    const sold = await this.purchaseRepo.count({
      where: { flashSaleId: sale.id, status: PurchaseStatus.CONFIRMED },
    });
    const remaining = Math.max(0, sale.totalInventory - sold);
    await this.redisService.syncInventory(sale.id, remaining);
    return remaining;
  }
}
