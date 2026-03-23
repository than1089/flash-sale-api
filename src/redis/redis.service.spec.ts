import { RedisService } from './redis.service';

describe('RedisService', () => {
  const mockClient = {
    set: jest.fn(),
    get: jest.fn(),
    eval: jest.fn(),
    incr: jest.fn(),
    srem: jest.fn(),
    del: jest.fn(),
    ping: jest.fn(),
  } as any;

  let service: RedisService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new RedisService(mockClient);
  });

  it('builds inventory key correctly', () => {
    expect(service.inventoryKey('sale-1')).toBe('flash_sale:sale-1:inventory');
  });

  it('builds purchasers key correctly', () => {
    expect(service.purchasersKey('sale-1')).toBe('flash_sale:sale-1:purchasers');
  });

  it('initializes inventory using NX', async () => {
    mockClient.set.mockResolvedValueOnce('OK');

    await service.initInventory('sale-1', 100);

    expect(mockClient.set).toHaveBeenCalledWith(
      'flash_sale:sale-1:inventory',
      100,
      'NX',
    );
  });

  it('returns null when remaining inventory key is missing', async () => {
    mockClient.get.mockResolvedValueOnce(null);

    const result = await service.getRemainingInventory('sale-1');

    expect(result).toBeNull();
    expect(mockClient.get).toHaveBeenCalledWith('flash_sale:sale-1:inventory');
  });

  it('parses remaining inventory value as a number', async () => {
    mockClient.get.mockResolvedValueOnce('42');

    const result = await service.getRemainingInventory('sale-1');

    expect(result).toBe(42);
  });

  it('clamps negative inventory values to 0', async () => {
    mockClient.get.mockResolvedValueOnce('-5');

    const result = await service.getRemainingInventory('sale-1');

    expect(result).toBe(0);
  });

  it('executes Lua script for purchase attempt and returns result', async () => {
    mockClient.eval.mockResolvedValueOnce(1);

    const result = await service.attemptPurchase('sale-1', 'alice@example.com');

    expect(result).toBe(1);
    expect(mockClient.eval).toHaveBeenCalledWith(
      expect.stringContaining("redis.call('SISMEMBER'"),
      2,
      'flash_sale:sale-1:inventory',
      'flash_sale:sale-1:purchasers',
      'alice@example.com',
    );
  });

  it('releases purchase slot by incrementing inventory and removing purchaser', async () => {
    mockClient.incr.mockResolvedValueOnce(10);
    mockClient.srem.mockResolvedValueOnce(1);

    const loggerWarnSpy = jest
      .spyOn((service as any).logger, 'warn')
      .mockImplementation(() => undefined);

    await service.releasePurchaseSlot('sale-1', 'alice@example.com');

    expect(mockClient.incr).toHaveBeenCalledWith('flash_sale:sale-1:inventory');
    expect(mockClient.srem).toHaveBeenCalledWith(
      'flash_sale:sale-1:purchasers',
      'alice@example.com',
    );
    expect(loggerWarnSpy).toHaveBeenCalledWith(
      'Compensated reservation for userEmail=alice@example.com sale=sale-1',
    );

    loggerWarnSpy.mockRestore();
  });

  it('syncs inventory directly to Redis', async () => {
    mockClient.set.mockResolvedValueOnce('OK');

    await service.syncInventory('sale-1', 77);

    expect(mockClient.set).toHaveBeenCalledWith('flash_sale:sale-1:inventory', 77);
  });

  it('stores JSON values with TTL', async () => {
    mockClient.set.mockResolvedValueOnce('OK');

    await service.setJson('cache:key', { foo: 'bar' }, 10);

    expect(mockClient.set).toHaveBeenCalledWith(
      'cache:key',
      JSON.stringify({ foo: 'bar' }),
      'EX',
      10,
    );
  });

  it('returns null on JSON cache miss', async () => {
    mockClient.get.mockResolvedValueOnce(null);

    const result = await service.getJson<{ foo: string }>('cache:key');

    expect(result).toBeNull();
  });

  it('parses JSON on cache hit', async () => {
    mockClient.get.mockResolvedValueOnce('{"foo":"bar"}');

    const result = await service.getJson<{ foo: string }>('cache:key');

    expect(result).toEqual({ foo: 'bar' });
  });

  it('deletes cache key', async () => {
    mockClient.del.mockResolvedValueOnce(1);

    await service.del('cache:key');

    expect(mockClient.del).toHaveBeenCalledWith('cache:key');
  });

  it('returns true when ping succeeds', async () => {
    mockClient.ping.mockResolvedValueOnce('PONG');

    const result = await service.isHealthy();

    expect(result).toBe(true);
  });

  it('returns false when ping fails', async () => {
    mockClient.ping.mockRejectedValueOnce(new Error('redis unavailable'));

    const result = await service.isHealthy();

    expect(result).toBe(false);
  });
});
