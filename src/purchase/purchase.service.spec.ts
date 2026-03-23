import {
  BadRequestException,
  ConflictException,
  GoneException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Repository } from 'typeorm';
import { PurchaseService } from './purchase.service';
import { Purchase, PurchaseStatus } from './entities/purchase.entity';
import { RedisService } from '../redis/redis.service';
import { FlashSaleService } from '../flash-sale/flash-sale.service';

describe('PurchaseService', () => {
  let service: PurchaseService;
  let loggerErrorSpy: jest.SpyInstance;

  const purchaseRepo = {
    create: jest.fn(),
    save: jest.fn(),
    findOne: jest.fn(),
  } as unknown as jest.Mocked<Repository<Purchase>>;

  const redisService = {
    attemptPurchase: jest.fn(),
    releasePurchaseSlot: jest.fn(),
  } as unknown as jest.Mocked<RedisService>;

  const flashSaleService = {
    findById: jest.fn(),
  } as unknown as jest.Mocked<FlashSaleService>;

  const activeSale = {
    id: 'sale-1',
    startTime: new Date(Date.now() - 60_000),
    endTime: new Date(Date.now() + 60_000),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    loggerErrorSpy = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    service = new PurchaseService(purchaseRepo, redisService, flashSaleService);
  });

  afterEach(() => {
    loggerErrorSpy.mockRestore();
  });

  it('throws 400 when sale has not started', async () => {
    flashSaleService.findById.mockResolvedValueOnce({
      ...activeSale,
      startTime: new Date(Date.now() + 60_000),
    } as any);

    await expect(
      service.attemptPurchase({ userEmail: 'alice@example.com', flashSaleId: 'sale-1' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('throws 410 when sale has ended', async () => {
    flashSaleService.findById.mockResolvedValueOnce({
      ...activeSale,
      endTime: new Date(Date.now() - 60_000),
    } as any);

    await expect(
      service.attemptPurchase({ userEmail: 'alice@example.com', flashSaleId: 'sale-1' }),
    ).rejects.toBeInstanceOf(GoneException);
  });

  it('throws 409 when user already purchased in Redis', async () => {
    flashSaleService.findById.mockResolvedValueOnce(activeSale as any);
    redisService.attemptPurchase.mockResolvedValueOnce(-1);

    await expect(
      service.attemptPurchase({ userEmail: 'alice@example.com', flashSaleId: 'sale-1' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('throws 410 when inventory is exhausted in Redis', async () => {
    flashSaleService.findById.mockResolvedValueOnce(activeSale as any);
    redisService.attemptPurchase.mockResolvedValueOnce(0);

    await expect(
      service.attemptPurchase({ userEmail: 'alice@example.com', flashSaleId: 'sale-1' }),
    ).rejects.toBeInstanceOf(GoneException);
  });

  it('saves and returns purchase on success', async () => {
    const persisted = {
      id: 'p-1',
      userEmail: 'alice@example.com',
      flashSaleId: 'sale-1',
      status: PurchaseStatus.CONFIRMED,
      createdAt: new Date(),
    } as Purchase;

    flashSaleService.findById.mockResolvedValueOnce(activeSale as any);
    redisService.attemptPurchase.mockResolvedValueOnce(1);
    purchaseRepo.create.mockReturnValueOnce(persisted as any);
    purchaseRepo.save.mockResolvedValueOnce(persisted as any);

    const result = await service.attemptPurchase({
      userEmail: 'alice@example.com',
      flashSaleId: 'sale-1',
    });

    expect(result).toEqual(persisted);
    expect(purchaseRepo.create).toHaveBeenCalledWith({
      userEmail: 'alice@example.com',
      flashSaleId: 'sale-1',
      status: PurchaseStatus.CONFIRMED,
    });
  });

  it('releases slot and throws 409 on DB unique violation', async () => {
    const uniqueErr = { code: '23505' };

    flashSaleService.findById.mockResolvedValueOnce(activeSale as any);
    redisService.attemptPurchase.mockResolvedValueOnce(1);
    purchaseRepo.create.mockReturnValueOnce({} as any);
    purchaseRepo.save.mockRejectedValueOnce(uniqueErr as any);

    await expect(
      service.attemptPurchase({ userEmail: 'alice@example.com', flashSaleId: 'sale-1' }),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(redisService.releasePurchaseSlot).toHaveBeenCalledWith(
      'sale-1',
      'alice@example.com',
    );
  });

  it('releases slot and rethrows unexpected DB failures', async () => {
    const dbErr = new Error('db down');

    flashSaleService.findById.mockResolvedValueOnce(activeSale as any);
    redisService.attemptPurchase.mockResolvedValueOnce(1);
    purchaseRepo.create.mockReturnValueOnce({} as any);
    purchaseRepo.save.mockRejectedValueOnce(dbErr);

    await expect(
      service.attemptPurchase({ userEmail: 'alice@example.com', flashSaleId: 'sale-1' }),
    ).rejects.toThrow('db down');

    expect(redisService.releasePurchaseSlot).toHaveBeenCalledWith(
      'sale-1',
      'alice@example.com',
    );
  });

  it('throws 404 when user purchase is not found', async () => {
    flashSaleService.findById.mockResolvedValueOnce(activeSale as any);
    purchaseRepo.findOne.mockResolvedValueOnce(null);

    await expect(
      service.getUserPurchaseStatus('alice@example.com', 'sale-1'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('returns purchase payload when user purchase exists', async () => {
    const purchase = {
      id: 'p-1',
      userEmail: 'alice@example.com',
      flashSaleId: 'sale-1',
      status: PurchaseStatus.CONFIRMED,
      createdAt: new Date(),
    } as Purchase;

    flashSaleService.findById.mockResolvedValueOnce(activeSale as any);
    purchaseRepo.findOne.mockResolvedValueOnce(purchase);

    const result = await service.getUserPurchaseStatus('alice@example.com', 'sale-1');

    expect(result).toEqual({
      userEmail: 'alice@example.com',
      flashSaleId: 'sale-1',
      purchase,
    });
  });
});
