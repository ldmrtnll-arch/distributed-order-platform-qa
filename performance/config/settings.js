import { Rate, Trend } from 'k6/metrics';

export const orderConfirmed = new Rate('order_confirmed');
export const orderDuration = new Trend('order_duration', true);

export const baseUrl = __ENV.BASE_URL || 'http://127.0.0.1:3001';
export const runId = __ENV.PERF_RUN_ID || `${Date.now()}`;

export const performanceThresholds = {
  http_req_failed: ['rate<0.01'],
  checks: ['rate>0.99'],
  order_confirmed: ['rate>0.99'],
  http_req_duration: ['p(95)<750', 'p(99)<1500'],
};

export const performanceSummaryTrendStats = [
  'avg',
  'min',
  'med',
  'max',
  'p(90)',
  'p(95)',
  'p(99)',
];

export function requestIdentity(prefix) {
  const suffix = `${runId}-${__VU}-${__ITER}-${Date.now()}`;
  return {
    correlationId: `perf-correlation-${prefix}-${suffix}`,
    idempotencyKey: `perf-${prefix}-${suffix}`,
  };
}

export function orderBody(sku) {
  return JSON.stringify({
    sku,
    quantity: 1,
    amountInCents: 5990,
    currency: 'BRL',
    paymentToken: 'tok_approved',
  });
}

export function requestParameters(identity) {
  return {
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'Idempotency-Key': identity.idempotencyKey,
      'X-Correlation-Id': identity.correlationId,
    },
    tags: { name: 'POST /orders' },
  };
}

export function parseJson(response) {
  try {
    return response.json();
  } catch {
    return null;
  }
}
