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
  paymentDeclined: {
    sku: 'ORDER-PAYMENT-DECLINED-001',
    name: 'Order Payment Declined Test Product',
    totalQuantity: 20,
  },
  paymentMethodRejected: {
    sku: 'ORDER-PAYMENT-REJECTED-001',
    name: 'Order Payment Method Rejected Test Product',
    totalQuantity: 20,
  },
  paymentUnavailable: {
    sku: 'ORDER-PAYMENT-RESILIENCE-001',
    name: 'Order Payment Resilience Test Product',
    totalQuantity: 20,
  },
  paymentTimeout: {
    sku: 'ORDER-PAYMENT-TIMEOUT-001',
    name: 'Order Payment Timeout Test Product',
    totalQuantity: 20,
  },
  paymentInvalidContract: {
    sku: 'ORDER-PAYMENT-INVALID-CONTRACT-001',
    name: 'Order Payment Invalid Contract Test Product',
    totalQuantity: 20,
  },
  paymentUnexpectedStatus: {
    sku: 'ORDER-PAYMENT-UNEXPECTED-STATUS-001',
    name: 'Order Payment Unexpected Status Test Product',
    totalQuantity: 20,
  },
  compensationFailed: {
    sku: 'ORDER-COMPENSATION-FAILED-001',
    name: 'Order Compensation Failed Test Product',
    totalQuantity: 20,
  },
  eventConfirmed: {
    sku: 'ORDER-EVENT-CONFIRMED-001',
    name: 'Order Confirmed Event Test Product',
    totalQuantity: 20,
  },
  eventInventoryRejected: {
    sku: 'ORDER-EVENT-INVENTORY-REJECTED-001',
    name: 'Order Inventory Rejected Event Test Product',
    totalQuantity: 20,
    seed: false,
  },
  eventPaymentDeclined: {
    sku: 'ORDER-EVENT-PAYMENT-DECLINED-001',
    name: 'Order Payment Declined Event Test Product',
    totalQuantity: 20,
  },
  eventConcurrent: {
    sku: 'ORDER-EVENT-CONCURRENT-001',
    name: 'Order Concurrent Event Test Product',
    totalQuantity: 20,
  },
  eventBrokerOutage: {
    sku: 'ORDER-EVENT-BROKER-OUTAGE-001',
    name: 'Order Broker Outage Event Test Product',
    totalQuantity: 20,
  },
  eventNotificationDown: {
    sku: 'ORDER-EVENT-NOTIFICATION-DOWN-001',
    name: 'Order Notification Down Event Test Product',
    totalQuantity: 20,
  },
  eventCompensationFailed: {
    sku: 'ORDER-EVENT-COMPENSATION-FAILED-001',
    name: 'Order Compensation Failed Event Test Product',
    totalQuantity: 20,
  },
  insufficientStock: {
    sku: 'ORDER-INSUFFICIENT-001',
    name: 'Order Insufficient Stock Test Product',
    totalQuantity: 2,
  },
} as const;
