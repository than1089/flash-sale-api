import {
  BadRequestException,
  INestApplication,
  NotFoundException,
  ValidationPipe,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { FlashSaleController } from './flash-sale.controller';
import { FlashSaleService } from './flash-sale.service';
import { ApiKeyGuard } from '../auth/api-key.guard';
import { FlashSaleStatus } from './enums/flash-sale-status.enum';

describe('FlashSaleController (integration)', () => {
  let app: INestApplication<App>;

  const ADMIN_API_KEY = 'test-admin-key';

  const flashSaleServiceMock = {
    create: jest.fn(),
    getMostRelevantSale: jest.fn(),
  };

  const salePayload = {
    id: 'sale-1',
    productName: 'Limited Edition Sneakers',
    price: 120,
    salePrice: 79.99,
    startTime: new Date('2026-03-23T11:00:00.000Z'),
    endTime: new Date('2026-03-23T13:00:00.000Z'),
    totalInventory: 100,
    createdAt: new Date('2026-03-23T10:00:00.000Z'),
  };

  const validCreateDto = {
    productName: 'Limited Edition Sneakers',
    price: 120,
    salePrice: 79.99,
    startTime: '2026-03-23T14:00:00.000Z',
    endTime: '2026-03-23T16:00:00.000Z',
    totalInventory: 100,
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [FlashSaleController],
      providers: [
        { provide: FlashSaleService, useValue: flashSaleServiceMock },
        ApiKeyGuard,
        {
          provide: ConfigService,
          useValue: { get: () => ADMIN_API_KEY },
        },
      ],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }),
    );
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  // ── POST /flash-sales ───────────────────────────────────────────────────────

  describe('POST /flash-sales', () => {
    it('returns 201 with the created sale when a valid request is sent with the correct API key', async () => {
      flashSaleServiceMock.create.mockResolvedValueOnce(salePayload);

      await request(app.getHttpServer())
        .post('/flash-sales')
        .set('x-api-key', ADMIN_API_KEY)
        .send(validCreateDto)
        .expect(201)
        .expect((res) => {
          expect(res.body.id).toBe('sale-1');
          expect(res.body.productName).toBe('Limited Edition Sneakers');
        });

      expect(flashSaleServiceMock.create).toHaveBeenCalledWith(validCreateDto);
    });

    it('returns 401 when the x-api-key header is missing', async () => {
      await request(app.getHttpServer())
        .post('/flash-sales')
        .send(validCreateDto)
        .expect(401);

      expect(flashSaleServiceMock.create).not.toHaveBeenCalled();
    });

    it('returns 401 when an incorrect API key is sent', async () => {
      await request(app.getHttpServer())
        .post('/flash-sales')
        .set('x-api-key', 'wrong-key')
        .send(validCreateDto)
        .expect(401);

      expect(flashSaleServiceMock.create).not.toHaveBeenCalled();
    });

    it('returns 400 when required body fields are missing', async () => {
      await request(app.getHttpServer())
        .post('/flash-sales')
        .set('x-api-key', ADMIN_API_KEY)
        .send({ productName: 'Sneakers' })
        .expect(400);

      expect(flashSaleServiceMock.create).not.toHaveBeenCalled();
    });

    it('returns 400 when extra unknown fields are sent', async () => {
      await request(app.getHttpServer())
        .post('/flash-sales')
        .set('x-api-key', ADMIN_API_KEY)
        .send({ ...validCreateDto, unknownField: 'oops' })
        .expect(400);

      expect(flashSaleServiceMock.create).not.toHaveBeenCalled();
    });

    it('returns 400 when the service throws a BadRequestException (e.g. endTime before startTime)', async () => {
      flashSaleServiceMock.create.mockRejectedValueOnce(
        new BadRequestException('endTime must be after startTime'),
      );

      await request(app.getHttpServer())
        .post('/flash-sales')
        .set('x-api-key', ADMIN_API_KEY)
        .send(validCreateDto)
        .expect(400)
        .expect((res) => {
          expect(res.body.message).toBe('endTime must be after startTime');
        });
    });
  });

  // ── GET /flash-sales/status ─────────────────────────────────────────────────

  describe('GET /flash-sales/status', () => {
    it('returns 200 with flattened sale status for an active sale', async () => {
      flashSaleServiceMock.getMostRelevantSale.mockResolvedValueOnce({
        sale: salePayload,
        status: FlashSaleStatus.ACTIVE,
        remainingInventory: 47,
      });

      await request(app.getHttpServer())
        .get('/flash-sales/status')
        .expect(200)
        .expect((res) => {
          expect(res.body.id).toBe('sale-1');
          expect(res.body.productName).toBe('Limited Edition Sneakers');
          expect(res.body.price).toBe(120);
          expect(res.body.salePrice).toBe(79.99);
          expect(res.body.status).toBe(FlashSaleStatus.ACTIVE);
          expect(res.body.totalInventory).toBe(100);
          expect(res.body.remainingInventory).toBe(47);
        });
    });

    it('returns 200 with UPCOMING status', async () => {
      flashSaleServiceMock.getMostRelevantSale.mockResolvedValueOnce({
        sale: salePayload,
        status: FlashSaleStatus.UPCOMING,
        remainingInventory: 100,
      });

      await request(app.getHttpServer())
        .get('/flash-sales/status')
        .expect(200)
        .expect((res) => {
          expect(res.body.status).toBe(FlashSaleStatus.UPCOMING);
          expect(res.body.remainingInventory).toBe(100);
        });
    });

    it('returns 200 with ENDED status when inventory is exhausted', async () => {
      flashSaleServiceMock.getMostRelevantSale.mockResolvedValueOnce({
        sale: salePayload,
        status: FlashSaleStatus.ENDED,
        remainingInventory: 0,
      });

      await request(app.getHttpServer())
        .get('/flash-sales/status')
        .expect(200)
        .expect((res) => {
          expect(res.body.status).toBe(FlashSaleStatus.ENDED);
          expect(res.body.remainingInventory).toBe(0);
        });
    });

    it('returns 404 when no flash sale exists', async () => {
      flashSaleServiceMock.getMostRelevantSale.mockRejectedValueOnce(
        new NotFoundException('No flash sale found'),
      );

      await request(app.getHttpServer())
        .get('/flash-sales/status')
        .expect(404)
        .expect((res) => {
          expect(res.body.message).toBe('No flash sale found');
        });
    });

    it('does not expose private fields that are not part of the response shape', async () => {
      flashSaleServiceMock.getMostRelevantSale.mockResolvedValueOnce({
        sale: salePayload,
        status: FlashSaleStatus.ACTIVE,
        remainingInventory: 10,
      });

      const res = await request(app.getHttpServer())
        .get('/flash-sales/status')
        .expect(200);

      // createdAt is intentionally excluded from the status response
      expect(res.body).not.toHaveProperty('createdAt');
    });
  });
});
