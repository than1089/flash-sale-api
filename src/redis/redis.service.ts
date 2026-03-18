import { Injectable, Inject, Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';

/**
 * Lua script executed atomically by Redis.
 *
 * Returns:
 *  -1  → user has already purchased
 *   0  → sold out (inventory exhausted)
 *   1  → purchase slot reserved successfully
 *
 * KEYS[1] = inventory counter  e.g. flash_sale:{id}:inventory
 * KEYS[2] = purchasers set     e.g. flash_sale:{id}:purchasers
 * ARGV[1] = userEmail
 */
const ATTEMPT_PURCHASE_SCRIPT = `
local already = redis.call('SISMEMBER', KEYS[2], ARGV[1])
if already == 1 then
  return -1
end

local inventory = tonumber(redis.call('GET', KEYS[1]))
if not inventory or inventory <= 0 then
  return 0
end

redis.call('DECR', KEYS[1])
redis.call('SADD', KEYS[2], ARGV[1])
return 1
`;

@Injectable()
export class RedisService {
  private readonly logger = new Logger(RedisService.name);

  constructor(@Inject('REDIS_CLIENT') private readonly client: Redis) {}

  inventoryKey(flashSaleId: string): string {
    return `flash_sale:${flashSaleId}:inventory`;
  }

  purchasersKey(flashSaleId: string): string {
    return `flash_sale:${flashSaleId}:purchasers`;
  }

  /** Seed inventory counter when a flash sale is created (idempotent via NX). */
  async initInventory(flashSaleId: string, total: number): Promise<void> {
    await this.client.set(this.inventoryKey(flashSaleId), total, 'NX');
  }

  /** Returns the current remaining inventory, or null if key is missing. */
  async getRemainingInventory(flashSaleId: string): Promise<number | null> {
    const value = await this.client.get(this.inventoryKey(flashSaleId));
    if (value === null) return null;
    return Math.max(0, parseInt(value, 10));
  }

  /**
   * Atomically attempts to reserve a purchase slot.
   * @returns  1 = success, 0 = sold out, -1 = already purchased
   */
  async attemptPurchase(
    flashSaleId: string,
    userEmail: string,
  ): Promise<number> {
    const result = await this.client.eval(
      ATTEMPT_PURCHASE_SCRIPT,
      2,
      this.inventoryKey(flashSaleId),
      this.purchasersKey(flashSaleId),
      userEmail,
    );
    return result as number;
  }

  /**
   * Compensate a failed DB write by releasing the reserved slot back to Redis.
   */
  async releasePurchaseSlot(
    flashSaleId: string,
    userEmail: string,
  ): Promise<void> {
    await Promise.all([
      this.client.incr(this.inventoryKey(flashSaleId)),
      this.client.srem(this.purchasersKey(flashSaleId), userEmail),
    ]);
    this.logger.warn(
      `Compensated reservation for userEmail=${userEmail} sale=${flashSaleId}`,
    );
  }

  /** Re-sync inventory from the DB count on startup (Redis cold start). */
  async syncInventory(flashSaleId: string, remaining: number): Promise<void> {
    await this.client.set(this.inventoryKey(flashSaleId), remaining);
  }

  /** Store any JSON-serialisable value with an optional TTL in seconds. */
  async setJson<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
    await this.client.set(key, JSON.stringify(value), 'EX', ttlSeconds);
  }

  /** Retrieve and parse a cached JSON value, or null on miss. */
  async getJson<T>(key: string): Promise<T | null> {
    const raw = await this.client.get(key);
    if (raw === null) return null;
    return JSON.parse(raw) as T;
  }

  /** Invalidate a cache key (e.g. after a sale is created). */
  async del(key: string): Promise<void> {
    await this.client.del(key);
  }

  async isHealthy(): Promise<boolean> {
    try {
      await this.client.ping();
      return true;
    } catch {
      return false;
    }
  }
}
