import { ConflictException, GoneException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Repository } from 'typeorm';
import { PurchaseService } from './purchase.service';
import { Purchase, PurchaseStatus } from './entities/purchase.entity';
import { RedisService } from '../redis/redis.service';
import { FlashSaleService } from '../flash-sale/flash-sale.service';

// DB repository mock with in-memory storage and unique constraint simulation
class InMemoryPurchaseRepo {
  private readonly records: Purchase[] = [];

  create(input: Partial<Purchase>): Purchase {
    return {
      id: randomUUID(),
      userEmail: input.userEmail ?? '',
      flashSaleId: input.flashSaleId ?? '',
      status: (input.status as PurchaseStatus) ?? PurchaseStatus.CONFIRMED,
      createdAt: new Date(),
    } as Purchase;
  }

  async save(purchase: Purchase): Promise<Purchase> {
    const duplicate = this.records.some(
      (item) =>
        item.userEmail === purchase.userEmail &&
        item.flashSaleId === purchase.flashSaleId,
    );

    if (duplicate) {
      const err = new Error('duplicate purchase') as Error & { code: string };
      err.code = '23505';
      throw err;
    }

    this.records.push(purchase);
    return purchase;
  }
}

class InMemoryRedisService {
  private readonly inventory = new Map<string, number>();
  private readonly purchasers = new Map<string, Set<string>>();

  constructor(private readonly jitterMs = 0) {}

  setInventory(flashSaleId: string, quantity: number): void {
    this.inventory.set(flashSaleId, quantity);
    this.purchasers.set(flashSaleId, new Set());
  }

  async attemptPurchase(flashSaleId: string, userEmail: string): Promise<number> {
    if (this.jitterMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, Math.floor(Math.random() * this.jitterMs)));
    }

    const purchasers = this.purchasers.get(flashSaleId) ?? new Set<string>();
    const remaining = this.inventory.get(flashSaleId) ?? 0;

    if (purchasers.has(userEmail)) return -1;
    if (remaining <= 0) return 0;

    purchasers.add(userEmail);
    this.purchasers.set(flashSaleId, purchasers);
    this.inventory.set(flashSaleId, remaining - 1);
    return 1;
  }

  async releasePurchaseSlot(flashSaleId: string, userEmail: string): Promise<void> {
    const purchasers = this.purchasers.get(flashSaleId) ?? new Set<string>();
    if (purchasers.delete(userEmail)) {
      const remaining = this.inventory.get(flashSaleId) ?? 0;
      this.inventory.set(flashSaleId, remaining + 1);
    }
  }
}

describe('PurchaseService stress', () => {
  const saleId = 'stress-sale-1';
  const activeSale = {
    id: saleId,
    startTime: new Date(Date.now() - 60_000),
    endTime: new Date(Date.now() + 60_000),
  };

  it('handles high concurrency and caps success at inventory size', async () => {
    const inventory = 120;
    const totalUsers = 10000;

    const repo = new InMemoryPurchaseRepo();
    const redis = new InMemoryRedisService(2);
    redis.setInventory(saleId, inventory);

    const flashSaleService = {
      findById: jest.fn().mockResolvedValue(activeSale),
    } as unknown as FlashSaleService;

    const service = new PurchaseService(
      repo as unknown as Repository<Purchase>,
      redis as unknown as RedisService,
      flashSaleService,
    );

    const results = await Promise.allSettled(
      Array.from({ length: totalUsers }, (_, i) =>
        service.attemptPurchase({
          userEmail: `load-user-${i}@example.com`,
          flashSaleId: saleId,
        }),
      ),
    );

    const successes = results.filter((r) => r.status === 'fulfilled').length;
    const soldOut = results.filter(
      (r) => r.status === 'rejected' && r.reason instanceof GoneException,
    ).length;

    expect(successes).toBe(inventory);
    expect(soldOut).toBe(totalUsers - inventory);
  });

  it('prevents duplicate purchases from the same user under concurrent retries', async () => {
    const uniqueUsers = 1000;
    const attemptsPerUser = 10;
    const inventory = 60;

    const repo = new InMemoryPurchaseRepo();
    const redis = new InMemoryRedisService(2);
    redis.setInventory(saleId, inventory);

    const flashSaleService = {
      findById: jest.fn().mockResolvedValue(activeSale),
    } as unknown as FlashSaleService;

    const service = new PurchaseService(
      repo as unknown as Repository<Purchase>,
      redis as unknown as RedisService,
      flashSaleService,
    );

    const attempts = Array.from({ length: uniqueUsers }).flatMap((_, userIndex) => {
      const email = `duplicate-user-${userIndex}@example.com`;
      return Array.from({ length: attemptsPerUser }, () => ({
        email,
        promise: service.attemptPurchase({
          userEmail: email,
          flashSaleId: saleId,
        }),
      }));
    });

    const results = await Promise.allSettled(attempts.map((a) => a.promise));

    const successes = results.filter((r) => r.status === 'fulfilled').length;
    const duplicates = results.filter(
      (r) => r.status === 'rejected' && r.reason instanceof ConflictException,
    ).length;
    const soldOut = results.filter(
      (r) => r.status === 'rejected' && r.reason instanceof GoneException,
    ).length;

    const successPerUser = new Map<string, number>();
    results.forEach((result, idx) => {
      if (result.status === 'fulfilled') {
        const email = attempts[idx].email;
        successPerUser.set(email, (successPerUser.get(email) ?? 0) + 1);
      }
    });

    expect(successes).toBe(inventory);
    expect(duplicates + soldOut).toBe(uniqueUsers * attemptsPerUser - inventory);
    // Ensure no user had more than 1 successful purchase
    expect(Math.max(...successPerUser.values(), 0)).toBeLessThanOrEqual(1);
  });
});
