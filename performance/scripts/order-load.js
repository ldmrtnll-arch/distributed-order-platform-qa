import http from 'k6/http';
import { check, sleep } from 'k6';

import { performanceSkus } from '../data/products.js';
import {
  baseUrl,
  performanceThresholds,
  orderBody,
  orderConfirmed,
  orderDuration,
  parseJson,
  performanceSummaryTrendStats,
  requestIdentity,
  requestParameters,
} from '../config/settings.js';

export const options = {
  summaryTrendStats: performanceSummaryTrendStats,
  stages: [
    { duration: '5s', target: 5 },
    { duration: '10s', target: 5 },
    { duration: '5s', target: 10 },
    { duration: '10s', target: 10 },
    { duration: '5s', target: 0 },
  ],
  thresholds: performanceThresholds,
};

export default function () {
  const identity = requestIdentity('load');
  const response = http.post(
    `${baseUrl}/orders`,
    orderBody(performanceSkus.order),
    requestParameters(identity),
  );
  const body = parseJson(response);
  const confirmed = check(response, {
    'created with HTTP 201': (result) => result.status === 201,
    'returns JSON': (result) =>
      String(result.headers['Content-Type']).includes('application/json'),
    'returns CONFIRMED': () => body?.status === 'CONFIRMED',
    'returns an orderId': () =>
      typeof body?.orderId === 'string' && body.orderId.length > 0,
  });

  orderConfirmed.add(confirmed);
  orderDuration.add(response.timings.duration);
  sleep(1);
}
