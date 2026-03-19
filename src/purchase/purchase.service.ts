import {
  Injectable,
  Logger,
  ConflictException,
  GoneException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Purchase, PurchaseStatus } from './entities/purchase.entity';
import { AttemptPurchaseDto } from './dto/attempt-purchase.dto';
import { RedisService } from '../redis/redis.service';
import { FlashSaleService } from '../flash-sale/flash-sale.service';

@Injectable()
export class PurchaseService {
  private readonly logger = new Logger(PurchaseService.name);

  constructor(
    @InjectRepository(Purchase)
    private readonly purchaseRepo: Repository<Purchase>,
    private readonly redisService: RedisService,
    private readonly flashSaleService: FlashSaleService,
  ) {}

  /**
   * Attempt to purchase an item in a flash sale.
   *
   * Concurrency strategy:
   *  1. Validate the sale is currently active.
   *  2. Execute a Redis Lua script atomically:
  *       - Reject if user email already purchased (-1)
   *       - Reject if inventory is exhausted (0)
  *       - Decrement inventory + add user email to purchasers set (1)
   *  3. Persist the confirmed purchase to PostgreSQL.
   *  4. If DB write fails, compensate by releasing the Redis slot.
   */
  async attemptPurchase(dto: AttemptPurchaseDto): Promise<Purchase> {
    const sale = await this.flashSaleService.findById(dto.flashSaleId);
    const now = new Date();

    // Guard: sale window check (before touching Redis)
    if (now < sale.startTime) {
      throw new BadRequestException('The flash sale has not started yet');
    }
    if (now > sale.endTime) {
      throw new GoneException('The flash sale has already ended');
    }

    // Atomic Redis operation
    const result = await this.redisService.attemptPurchase(
      sale.id,
      dto.userEmail,
    );

    if (result === -1) {
      throw new ConflictException('You have already purchased this item');
    }
    if (result === 0) {
      throw new GoneException('Sorry, all items have been sold out');
    }

    // Persist to DB; compensate Redis if this fails
    try {
      const purchase = this.purchaseRepo.create({
        userEmail: dto.userEmail,
        flashSaleId: sale.id,
        status: PurchaseStatus.CONFIRMED,
      });
      return await this.purchaseRepo.save(purchase);
    } catch (err) {
      // Unique constraint violation — duplicate purchase already in DB
      if ((err as any)?.code === '23505') {
        // Release the Redis slot we just took (user will see the DB record)
        await this.redisService.releasePurchaseSlot(sale.id, dto.userEmail);
        throw new ConflictException('You have already purchased this item');
      }
      // Unexpected DB failure — release Redis reservation to avoid inventory loss
      await this.redisService.releasePurchaseSlot(sale.id, dto.userEmail);
      this.logger.error(
        `DB write failed for userEmail=${dto.userEmail} sale=${sale.id}`,
        err,
      );
      throw err;
    }
  }

  /**
   * Check whether a user has successfully secured an item in a given flash sale.
   */
  async getUserPurchaseStatus(
    userEmail: string,
    flashSaleId: string,
  ): Promise<{
    userEmail: string;
    flashSaleId: string;
    secured: boolean;
    purchase: Purchase | null;
  }> {
    // Validate sale exists
    await this.flashSaleService.findById(flashSaleId);

    const purchase = await this.purchaseRepo.findOne({
      where: {
        userEmail,
        flashSaleId,
        status: PurchaseStatus.CONFIRMED,
      },
    });

    return {
      userEmail,
      flashSaleId,
      secured: purchase !== null,
      purchase: purchase ?? null,
    };
  }

  async getUserPurchases(userEmail: string): Promise<Purchase[]> {
    if (!userEmail?.trim()) {
      throw new BadRequestException('userEmail is required');
    }

    return this.purchaseRepo.find({
      where: {
        userEmail: userEmail.trim(),
        status: PurchaseStatus.CONFIRMED,
      },
      order: { createdAt: 'DESC' },
    });
  }
}
