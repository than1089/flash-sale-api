# Flash Sale API

A high-concurrency flash sale backend built with **NestJS**, **PostgreSQL**, and **Redis**. It handles simultaneous purchase attempts safely using atomic Redis Lua scripts, preventing overselling and duplicate purchases without database-level locks.

---

## Table of Contents

- [Design Choices and Trade-offs](#design-choices-and-trade-offs)
- [System Diagram](#system-diagram)
- [Prerequisites](#prerequisites)
- [Environment Setup](#environment-setup)
- [Running the Server](#running-the-server)
- [API Overview](#api-overview)
- [Running Tests](#running-tests)
- [Stress Tests](#stress-tests)

---

## Design Choices and Trade-offs

### Redis as the concurrency gate

All inventory state lives in Redis. A single atomic Lua script checks membership, reads the counter, and decrements in one round-trip — no race conditions are possible. PostgreSQL is only written to after Redis has confirmed the reservation.

### PostgreSQL as the source of truth

Redis is fast but not durable by default. Every confirmed purchase is persisted to PostgreSQL. If a DB write fails after a successful Redis reservation, the slot is immediately compensated (released back) to prevent inventory drift.

### Sale metadata cache

`GET /flash-sales/status` is the highest-read endpoint. The flash sale row is cached in Redis for 10 seconds to reduce PostgreSQL load. Inventory is **always** read fresh from the Redis counter, so the displayed remaining stock is never stale.

### Trade-offs

| Decision | Benefit | Trade-off |
|---|---|---|
| Redis Lua for atomicity | Zero oversell, no DB locks | Redis is a SPOF without replication |
| Metadata cache (10 s TTL) | Reduced DB reads at scale | Sale details can lag by up to 10 s after creation |
| TypeORM `synchronize: true` | Fast local development | Must switch to migrations before production |
| Single Redis node (dev) | Simple local setup | Add Redis Sentinel or Cluster for HA in production |
| Single PostgreSQL instance | Simpler operations and local setup | Add replicas/failover for HA and read scaling in production |

---

## System Diagram

### Infrastructure

```mermaid
flowchart TB
  Clients["Client Apps\nUsers interact through web, mobile, or API tools"]

    Clients -->|HTTPS| LB

    subgraph INFRA["Infrastructure"]
    LB["Load Balancer\nDistributes incoming traffic across API instances"]

        subgraph API_CLUSTER["API Cluster (horizontally scalable)"]
      API1["NestJS API Instance 1\nHandles requests and runs business logic"]
      API2["NestJS API Instance 2\nHandles requests and runs business logic"]
        end

    REDIS["Redis\nProvides fast inventory control, duplicate protection, and caching"]

    PG["PostgreSQL\nPersists flash sales and confirmed purchases durably"]
    end

    LB -->|HTTP round-robin| API1
    LB -->|HTTP round-robin| API2

    API1 -->|ioredis TCP| REDIS
    API2 -->|ioredis TCP| REDIS

    API1 -->|TypeORM TCP| PG
    API2 -->|TypeORM TCP| PG
```

  Component roles:

  - Client Apps: users or testers sending requests to the backend.
  - Load Balancer: spreads traffic across multiple API instances.
  - API Instances: validate requests, apply business rules, and coordinate Redis and PostgreSQL.
  - Redis: protects the hot purchase path where concurrency matters most.
  - PostgreSQL: stores durable business records that must survive restarts and failures.

### Application Modules

```mermaid
flowchart LR
    subgraph API_LAYER[Application Layer]
      FSC[FlashSaleController]
      PSC[PurchaseController]
      FSS[FlashSaleService]
      PSS[PurchaseService]
      RDS[RedisService]
    end

    FSC --> FSS
    PSC --> PSS
    PSS --> FSS
    FSS --> RDS
    PSS --> RDS

    subgraph REDIS_LAYER[Redis Keys]
      LUA[Atomic Lua Script\nSISMEMBER · GET · DECR · SADD]
      INV[Inventory Counter]
      SET[Purchasers Set]
      META[Sale Metadata Cache TTL 10s]
    end

    RDS --> LUA
    LUA --> INV
    LUA --> SET
    RDS --> META

    subgraph DB_LAYER[PostgreSQL Tables]
      FS_TABLE[flash_sales]
      PUR_TABLE[purchases\nUNIQUE user_email + flash_sale_id]
    end

    FSS --> FS_TABLE
    FSS --> PUR_TABLE
    PSS --> PUR_TABLE

    FSS -. startup inventory sync .-> INV
    PSS -. DB failure compensation .-> INV
    PSS -. DB failure compensation .-> SET
```

---

## Prerequisites

- Node.js 20+
- npm 10+
- Docker and Docker Compose (for local PostgreSQL and Redis)

---

## Environment Setup

Copy the example variables and adjust if needed:

```bash
cp .env.example .env   # if provided, otherwise create .env manually
```

The `.env` file used for local development:

```env
PORT=3000

DB_HOST=localhost
DB_PORT=5432
DB_USERNAME=postgres
DB_PASSWORD=postgres
DB_DATABASE=flash_sale

REDIS_HOST=localhost
REDIS_PORT=6379

ADMIN_API_KEY=Bo0k!p1_F$Admin
```

Start the required infrastructure services:

```bash
docker-compose up -d
```

This spins up PostgreSQL on port `5432` and Redis on port `6379`. The database schema is created automatically on first startup via TypeORM `synchronize`.

Install dependencies:

```bash
npm install
```

---

## Running the Server

```bash
# development with watch mode
npm run start:dev

# standard start
npm run start

# production build
npm run build
npm run start:prod
```

The API is available at `http://localhost:3000`.  
Interactive Swagger docs are at `http://localhost:3000/api`.

---

## API Overview

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/flash-sales` | `x-api-key` header | Create a flash sale |
| `GET` | `/flash-sales/status` | — | Get current sale status and remaining inventory |
| `POST` | `/purchases` | — | Attempt to purchase a flash sale item |
| `GET` | `/purchases/users/:userEmail?flashSaleId=` | — | Look up a user's purchase for a specific sale |

---

## Running Tests

```bash
# all unit tests (business logic)
npm run test:unit

# API endpoint integration tests (no DB or Redis required)
npm run test:integration

# full test suite
npm run test

# test coverage report
npm run test:cov
```

---

## Stress Tests

The stress tests simulate high volumes of concurrent purchase attempts entirely in-process using in-memory fakes for Redis and the database — no running infrastructure is needed.

```bash
npm run test:stress
```

### What the tests assert

**Test 1 — Inventory cap under load**

- 1,000 unique users attempt to purchase simultaneously
- Inventory is set to 120
- Expected: exactly 120 succeed, 880 are rejected with sold-out (410)

**Test 2 — Duplicate purchase prevention under retries**

- 100 unique users each fire 10 concurrent purchase requests (1,000 total)
- Inventory is set to 100
- Expected: exactly 100 succeed (one per user), 900 are rejected as duplicates (409)

### Why these results prove correctness

The atomic Redis Lua script (`SISMEMBER` → `GET` → `DECR` → `SADD`) is the single serialisation point. Even with thousands of concurrent coroutines, the script executes as a unit — no two requests can both read the same inventory value and both decrement it. The stress tests confirm that:

- Total confirmed purchases never exceed total inventory regardless of concurrency
- No user can hold more than one slot even when retrying aggressively
- DB-level unique constraints and Redis compensation work together to close any remaining gap
