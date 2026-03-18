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

  constructor(
    @InjectRepository(FlashSale)
    private readonly flashSaleRepo: Repository<FlashSale>,
    @InjectRepository(Purchase)
    private readonly purchaseRepo: Repository<Purchase>,
    private readonly redisService: RedisService,
  ) {}

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

    const sale = this.flashSaleRepo.create({
      productName: dto.productName,
      startTime: start,
      endTime: end,
      totalInventory: dto.totalInventory,
    });

    const saved = await this.flashSaleRepo.save(sale);
    await this.redisService.initInventory(saved.id, saved.totalInventory);
    return saved;
  }

  /**
   * Returns the most relevant single flash sale:
   * priority order — active → upcoming (soonest) → ended (most recent)
   */
  async getMostRelevantSale(): Promise<{
    sale: FlashSale;
    status: FlashSaleStatus;
    remainingInventory: number;
  }> {
    const now = new Date();

    // Try active first
    let sale = await this.flashSaleRepo.findOne({
      where: {
        startTime: LessThanOrEqual(now),
        endTime: MoreThanOrEqual(now),
      },
      order: { startTime: 'DESC' },
    });

    if (!sale) {
      // Try upcoming
      sale = await this.flashSaleRepo.findOne({
        where: { startTime: MoreThanOrEqual(now) },
        order: { startTime: 'ASC' },
      });
    }

    if (!sale) {
      // Most recently ended
      sale = await this.flashSaleRepo.findOne({
        order: { endTime: 'DESC' },
      });
    }

    if (!sale) {
      throw new NotFoundException('No flash sale found');
    }

    const remainingInventory = await this.getInventory(sale);
    const status = this.computeStatus(sale, remainingInventory);

    return { sale, status, remainingInventory };
  }

  async findById(id: string): Promise<FlashSale> {
    const sale = await this.flashSaleRepo.findOne({ where: { id } });
    if (!sale) throw new NotFoundException(`Flash sale ${id} not found`);
    return sale;
  }

  async getActiveSale(): Promise<FlashSale> {
    const now = new Date();
    const sale = await this.flashSaleRepo.findOne({
      where: {
        startTime: LessThanOrEqual(now),
        endTime: MoreThanOrEqual(now),
      },
      order: { startTime: 'DESC' },
    });
    if (!sale) throw new NotFoundException('No active flash sale');
    return sale;
  }

  private computeStatus(sale: FlashSale, remainingInventory: number): FlashSaleStatus {
    const now = new Date();
    if (now < sale.startTime) return FlashSaleStatus.UPCOMING;
    if (now > sale.endTime || remainingInventory <= 0)
      return FlashSaleStatus.ENDED;
    return FlashSaleStatus.ACTIVE;
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
