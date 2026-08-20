export const orderInventoryFixtures = {
  happyPath: {
    sku: 'ORDER-HAPPY-001',
    name: 'Order Happy Path Test Product',
    totalQuantity: 20,
  },
  idempotencyConflictSku: {
    sku: 'ORDER-CONFLICT-SKU-001',
    name: 'Order SKU Conflict Test Product',
    totalQuantity: 20,
  },
  idempotencyConflictQuantity: {
    sku: 'ORDER-CONFLICT-QUANTITY-001',
    name: 'Order Quantity Conflict Test Product',
    totalQuantity: 20,
  },
  idempotencyConflictAmount: {
    sku: 'ORDER-CONFLICT-AMOUNT-001',
    name: 'Order Amount Conflict Test Product',
    totalQuantity: 20,
  },
  idempotencyConflictToken: {
    sku: 'ORDER-CONFLICT-TOKEN-001',
    name: 'Order Payment Token Conflict Test Product',
    totalQuantity: 20,
  },
  concurrent: {
    sku: 'ORDER-CONCURRENT-001',
    name: 'Order Concurrency Test Product',
    totalQuantity: 20,
  },
  database: {
    sku: 'ORDER-DATABASE-001',
    name: 'Order Database Test Product',
    totalQuantity: 20,
  },
  databaseReplay: {
    sku: 'ORDER-DATABASE-REPLAY-001',
    name: 'Order Database Replay Test Product',
    totalQuantity: 20,
  },
  databaseConcurrent: {
    sku: 'ORDER-DATABASE-CONCURRENT-001',
    name: 'Order Database Concurrency Test Product',
    totalQuantity: 20,
  },
  resilience: {
    sku: 'ORDER-RESILIENCE-001',
    name: 'Order Resilience Test Product',
    totalQuantity: 20,
  },
  resilienceTimeout: {
    sku: 'ORDER-RESILIENCE-TIMEOUT-001',
    name: 'Order Resilience Timeout Test Product',
    totalQuantity: 20,
  },
  resilienceUnexpected409: {
    sku: 'ORDER-RESILIENCE-UNEXPECTED-409-001',
    name: 'Order Resilience Unexpected 409 Test Product',
    totalQuantity: 20,
  },
  resilienceInvalidContract: {
    sku: 'ORDER-RESILIENCE-INVALID-CONTRACT-001',
    name: 'Order Resilience Invalid Contract Test Product',
    totalQuantity: 20,
  },
  insufficientStock: {
    sku: 'ORDER-INSUFFICIENT-001',
    name: 'Order Insufficient Stock Test Product',
    totalQuantity: 2,
  },
} as const;
