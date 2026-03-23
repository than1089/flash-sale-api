import { BadRequestException, Logger, NotFoundException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { FlashSaleService } from './flash-sale.service';
import { FlashSale } from './entities/flash-sale.entity';
import { FlashSaleStatus } from './enums/flash-sale-status.enum';
import { CreateFlashSaleDto } from './dto/create-flash-sale.dto';
import { RedisService } from '../redis/redis.service';
import { Purchase, PurchaseStatus } from '../purchase/entities/purchase.entity';

describe('FlashSaleService', () => {
  let service: FlashSaleService;
  let loggerLogSpy: jest.SpyInstance;
  let loggerWarnSpy: jest.SpyInstance;

  const flashSaleRepo = {
    find: jest.fn(),
    findOne: jest.fn(),
    create: jest.fn(),
    save: jest.fn(),
  } as unknown as jest.Mocked<Repository<FlashSale>>;

  const purchaseRepo = {
    count: jest.fn(),
  } as unknown as jest.Mocked<Repository<Purchase>>;

  const redisService = {
    syncInventory: jest.fn(),
    initInventory: jest.fn(),
    del: jest.fn(),
    getJson: jest.fn(),
    setJson: jest.fn(),
    getRemainingInventory: jest.fn(),
  } as unknown as jest.Mocked<RedisService>;

  const NOW = new Date('2026-03-23T12:00:00.000Z');

  const activeSale: FlashSale = {
    id: 'sale-1',
    productName: 'Widget',
    price: 100,
    salePrice: 60,
    startTime: new Date('2026-03-23T11:00:00.000Z'),
    endTime: new Date('2026-03-23T13:00:00.000Z'),
    totalInventory: 50,
    createdAt: new Date('2026-03-23T10:00:00.000Z'),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
    loggerLogSpy = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined);
    loggerWarnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    service = new FlashSaleService(flashSaleRepo, purchaseRepo, redisService);
  });

  afterEach(() => {
    loggerLogSpy.mockRestore();
    loggerWarnSpy.mockRestore();
    jest.useRealTimers();
  });

  // ── onModuleInit ────────────────────────────────────────────────────────────

  describe('onModuleInit', () => {
    it('syncs remaining inventory for each relevant sale', async () => {
      const sales = [
        { ...activeSale, id: 'sale-1', totalInventory: 50 },
        { ...activeSale, id: 'sale-2', totalInventory: 20 },
      ];
      flashSaleRepo.find.mockResolvedValueOnce(sales as any);
      purchaseRepo.count
        .mockResolvedValueOnce(10) // 10 sold for sale-1 → 40 remaining
        .mockResolvedValueOnce(5); //  5 sold for sale-2 → 15 remaining

      await service.onModuleInit();

      expect(redisService.syncInventory).toHaveBeenCalledWith('sale-1', 40);
      expect(redisService.syncInventory).toHaveBeenCalledWith('sale-2', 15);
    });

    it('clamps remaining inventory to 0 when sold count exceeds total', async () => {
      flashSaleRepo.find.mockResolvedValueOnce([
        { ...activeSale, totalInventory: 5 },
      ] as any);
      purchaseRepo.count.mockResolvedValueOnce(10); // oversold edge-case

      await service.onModuleInit();

      expect(redisService.syncInventory).toHaveBeenCalledWith('sale-1', 0);
    });

    it('does nothing when there are no relevant sales', async () => {
      flashSaleRepo.find.mockResolvedValueOnce([]);

      await service.onModuleInit();

      expect(redisService.syncInventory).not.toHaveBeenCalled();
    });
  });

  // ── create ──────────────────────────────────────────────────────────────────

  describe('create', () => {
    const dto: CreateFlashSaleDto = {
      productName: 'Widget',
      price: 100,
      salePrice: 60,
      startTime: '2026-03-23T14:00:00.000Z',
      endTime: '2026-03-23T16:00:00.000Z',
      totalInventory: 50,
    };

    it('throws 400 when endTime equals startTime', async () => {
      await expect(
        service.create({ ...dto, endTime: dto.startTime }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('throws 400 when endTime is before startTime', async () => {
      await expect(
        service.create({ ...dto, endTime: '2026-03-23T13:00:00.000Z', startTime: '2026-03-23T14:00:00.000Z' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('throws 400 when salePrice exceeds price', async () => {
      await expect(
        service.create({ ...dto, salePrice: 150 }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('saves the sale, seeds inventory, busts the metadata cache, and returns the sale', async () => {
      flashSaleRepo.create.mockReturnValueOnce(activeSale as any);
      flashSaleRepo.save.mockResolvedValueOnce(activeSale as any);
      redisService.initInventory.mockResolvedValueOnce(undefined);
      redisService.del.mockResolvedValueOnce(undefined);

      const result = await service.create(dto);

      expect(flashSaleRepo.create).toHaveBeenCalledWith({
        productName: dto.productName,
        price: dto.price,
        salePrice: dto.salePrice,
        startTime: new Date(dto.startTime),
        endTime: new Date(dto.endTime),
        totalInventory: dto.totalInventory,
      });
      expect(redisService.initInventory).toHaveBeenCalledWith(
        activeSale.id,
        activeSale.totalInventory,
      );
      expect(redisService.del).toHaveBeenCalledWith('flash_sale:current:meta');
      expect(result).toEqual(activeSale);
    });
  });

  // ── getMostRelevantSale ─────────────────────────────────────────────────────

  describe('getMostRelevantSale', () => {
    it('returns cached sale from Redis without hitting the DB', async () => {
      redisService.getJson.mockResolvedValueOnce(activeSale);
      redisService.getRemainingInventory.mockResolvedValueOnce(30);

      const result = await service.getMostRelevantSale();

      expect(flashSaleRepo.findOne).not.toHaveBeenCalled();
      expect(result.sale).toEqual(activeSale);
      expect(result.remainingInventory).toBe(30);
      expect(result.status).toBe(FlashSaleStatus.ACTIVE);
    });

    it('queries the DB on cache miss and fires-and-forgets the cache write', async () => {
      redisService.getJson.mockResolvedValueOnce(null);
      flashSaleRepo.findOne.mockResolvedValueOnce(activeSale as any);
      redisService.setJson.mockResolvedValueOnce(undefined);
      redisService.getRemainingInventory.mockResolvedValueOnce(10);

      const result = await service.getMostRelevantSale();

      expect(flashSaleRepo.findOne).toHaveBeenCalledTimes(1);
      expect(redisService.setJson).toHaveBeenCalledWith(
        'flash_sale:current:meta',
        activeSale,
        10, // SALE_CACHE_TTL
      );
      expect(result.sale).toEqual(activeSale);
    });

    it('falls back to DB inventory count when Redis inventory key is missing', async () => {
      redisService.getJson.mockResolvedValueOnce(activeSale);
      redisService.getRemainingInventory.mockResolvedValueOnce(null); // cache miss
      purchaseRepo.count.mockResolvedValueOnce(20); // 20 of 50 sold → 30 remaining
      redisService.syncInventory.mockResolvedValueOnce(undefined);

      const result = await service.getMostRelevantSale();

      expect(purchaseRepo.count).toHaveBeenCalledWith({
        where: { flashSaleId: activeSale.id, status: PurchaseStatus.CONFIRMED },
      });
      expect(redisService.syncInventory).toHaveBeenCalledWith(activeSale.id, 30);
      expect(result.remainingInventory).toBe(30);
    });

    it('does not block the response when the cache write fails', async () => {
      redisService.getJson.mockResolvedValueOnce(null);
      flashSaleRepo.findOne.mockResolvedValueOnce(activeSale as any);
      redisService.setJson.mockRejectedValueOnce(new Error('Redis down'));
      redisService.getRemainingInventory.mockResolvedValueOnce(10);

      await expect(service.getMostRelevantSale()).resolves.toBeDefined();
    });

    it('throws 404 when no sales exist in the DB', async () => {
      redisService.getJson.mockResolvedValueOnce(null);
      flashSaleRepo.findOne.mockResolvedValue(null); // all three priority queries return null

      await expect(service.getMostRelevantSale()).rejects.toBeInstanceOf(NotFoundException);
    });

    it('returns UPCOMING status when the sale has not started yet', async () => {
      const upcomingSale = {
        ...activeSale,
        startTime: new Date(NOW.getTime() + 60_000),
        endTime: new Date(NOW.getTime() + 120_000),
      };
      redisService.getJson.mockResolvedValueOnce(upcomingSale);
      redisService.getRemainingInventory.mockResolvedValueOnce(50);

      const result = await service.getMostRelevantSale();

      expect(result.status).toBe(FlashSaleStatus.UPCOMING);
    });

    it('returns ENDED status when the sale endTime has passed', async () => {
      const endedSale = {
        ...activeSale,
        startTime: new Date(NOW.getTime() - 120_000),
        endTime: new Date(NOW.getTime() - 60_000),
      };
      redisService.getJson.mockResolvedValueOnce(endedSale);
      redisService.getRemainingInventory.mockResolvedValueOnce(10);

      const result = await service.getMostRelevantSale();

      expect(result.status).toBe(FlashSaleStatus.ENDED);
    });

    it('returns ENDED status when inventory is exhausted', async () => {
      redisService.getJson.mockResolvedValueOnce(activeSale);
      redisService.getRemainingInventory.mockResolvedValueOnce(0);

      const result = await service.getMostRelevantSale();

      expect(result.status).toBe(FlashSaleStatus.ENDED);
    });

    it('prefers active sale over upcoming in DB priority order', async () => {
      redisService.getJson.mockResolvedValueOnce(null);
      flashSaleRepo.findOne.mockResolvedValueOnce(activeSale as any); // active query hits
      redisService.setJson.mockResolvedValueOnce(undefined);
      redisService.getRemainingInventory.mockResolvedValueOnce(5);

      await service.getMostRelevantSale();

      // Should stop after the first findOne (active query)
      expect(flashSaleRepo.findOne).toHaveBeenCalledTimes(1);
    });

    it('falls back to upcoming sale when no active sale exists', async () => {
      const upcomingSale = {
        ...activeSale,
        startTime: new Date(NOW.getTime() + 60_000),
        endTime: new Date(NOW.getTime() + 180_000),
      };
      redisService.getJson.mockResolvedValueOnce(null);
      flashSaleRepo.findOne
        .mockResolvedValueOnce(null)               // no active sale
        .mockResolvedValueOnce(upcomingSale as any); // upcoming sale found
      redisService.setJson.mockResolvedValueOnce(undefined);
      redisService.getRemainingInventory.mockResolvedValueOnce(50);

      const result = await service.getMostRelevantSale();

      expect(flashSaleRepo.findOne).toHaveBeenCalledTimes(2);
      expect(result.sale).toEqual(upcomingSale);
      expect(result.status).toBe(FlashSaleStatus.UPCOMING);
    });

    it('falls back to most recent ended sale when no active or upcoming sale exists', async () => {
      const endedSale = {
        ...activeSale,
        startTime: new Date(NOW.getTime() - 120_000),
        endTime: new Date(NOW.getTime() - 60_000),
      };
      redisService.getJson.mockResolvedValueOnce(null);
      flashSaleRepo.findOne
        .mockResolvedValueOnce(null)              // no active sale
        .mockResolvedValueOnce(null)              // no upcoming sale
        .mockResolvedValueOnce(endedSale as any); // ended sale found
      redisService.setJson.mockResolvedValueOnce(undefined);
      redisService.getRemainingInventory.mockResolvedValueOnce(0);

      const result = await service.getMostRelevantSale();

      expect(flashSaleRepo.findOne).toHaveBeenCalledTimes(3);
      expect(result.sale).toEqual(endedSale);
      expect(result.status).toBe(FlashSaleStatus.ENDED);
    });
  });

  // ── findById ────────────────────────────────────────────────────────────────

  describe('findById', () => {
    it('throws 404 when no sale matches the given id', async () => {
      flashSaleRepo.findOne.mockResolvedValueOnce(null);

      await expect(service.findById('unknown-id')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('returns the sale when found', async () => {
      flashSaleRepo.findOne.mockResolvedValueOnce(activeSale as any);

      const result = await service.findById('sale-1');

      expect(result).toEqual(activeSale);
      expect(flashSaleRepo.findOne).toHaveBeenCalledWith({ where: { id: 'sale-1' } });
    });
  });
});
