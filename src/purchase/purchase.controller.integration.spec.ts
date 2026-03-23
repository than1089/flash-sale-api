import { INestApplication, NotFoundException, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { PurchaseController } from './purchase.controller';
import { PurchaseService } from './purchase.service';

describe('PurchaseController (integration)', () => {
  let app: INestApplication<App>;

  const purchaseServiceMock = {
    attemptPurchase: jest.fn(),
    getUserPurchaseStatus: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [PurchaseController],
      providers: [
        {
          provide: PurchaseService,
          useValue: purchaseServiceMock,
        },
      ],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }));
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('POST /purchases returns 201 for a valid purchase attempt', async () => {
    purchaseServiceMock.attemptPurchase.mockResolvedValueOnce({
      id: 'purchase-1',
      userEmail: 'alice@example.com',
      flashSaleId: 'sale-1',
      status: 'confirmed',
      createdAt: new Date('2026-03-19T10:00:00.000Z'),
    });

    await request(app.getHttpServer())
      .post('/purchases')
      .send({ userEmail: 'alice@example.com', flashSaleId: 'sale-1' })
      .expect(201);

    expect(purchaseServiceMock.attemptPurchase).toHaveBeenCalledWith({
      userEmail: 'alice@example.com',
      flashSaleId: 'sale-1',
    });
  });

  it('POST /purchases returns 400 when required body fields are missing', async () => {
    await request(app.getHttpServer())
      .post('/purchases')
      .send({ userEmail: 'alice@example.com' })
      .expect(400);

    expect(purchaseServiceMock.attemptPurchase).not.toHaveBeenCalled();
  });

  it('GET /purchases/users/:userEmail returns purchase status payload', async () => {
    purchaseServiceMock.getUserPurchaseStatus.mockResolvedValueOnce({
      userEmail: 'alice@example.com',
      flashSaleId: 'sale-1',
      purchase: {
        id: 'purchase-1',
        status: 'confirmed',
      },
    });

    await request(app.getHttpServer())
      .get('/purchases/users/alice@example.com')
      .query({ flashSaleId: 'sale-1' })
      .expect(200)
      .expect((res) => {
        expect(res.body.userEmail).toBe('alice@example.com');
        expect(res.body.flashSaleId).toBe('sale-1');
      });

    expect(purchaseServiceMock.getUserPurchaseStatus).toHaveBeenCalledWith(
      'alice@example.com',
      'sale-1',
    );
  });

  it('GET /purchases/users/:userEmail returns 404 when purchase is not found', async () => {
    purchaseServiceMock.getUserPurchaseStatus.mockRejectedValueOnce(
      new NotFoundException('Purchase not found'),
    );

    await request(app.getHttpServer())
      .get('/purchases/users/alice@example.com')
      .query({ flashSaleId: 'sale-1' })
      .expect(404);
  });
});
