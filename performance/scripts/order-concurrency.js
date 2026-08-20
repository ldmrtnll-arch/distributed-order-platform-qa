import http from 'k6/http';
import { check } from 'k6';
import { Rate } from 'k6/metrics';

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

const idempotentPair = new Rate('idempotent_pair');

export const options = {
  summaryTrendStats: performanceSummaryTrendStats,
  scenarios: {
    concurrency: {
      executor: 'per-vu-iterations',
      vus: 5,
      iterations: 3,
      maxDuration: '30s',
    },
  },
  thresholds: {
    ...performanceThresholds,
    idempotent_pair: ['rate>0.99'],
  },
};

export default function () {
  const identity = requestIdentity('concurrency');
  const body = orderBody(performanceSkus.concurrency);
  const parameters = requestParameters(identity);
  const responses = http.batch([
    ['POST', `${baseUrl}/orders`, body, parameters],
    ['POST', `${baseUrl}/orders`, body, parameters],
  ]);
  const firstBody = parseJson(responses[0]);
  const secondBody = parseJson(responses[1]);
  const statuses = responses.map((response) => response.status).sort();
  const replay = responses.find((response) => response.status === 200);
  const pairIsIdempotent = check(responses, {
    'pair returns HTTP 200 and 201': () =>
      statuses[0] === 200 && statuses[1] === 201,
    'pair returns the same orderId': () =>
      typeof firstBody?.orderId === 'string' &&
      firstBody.orderId === secondBody?.orderId,
    'pair returns CONFIRMED': () =>
      firstBody?.status === 'CONFIRMED' && secondBody?.status === 'CONFIRMED',
    'replay header is true': () =>
      String(replay?.headers['Idempotent-Replay']).toLowerCase() === 'true',
  });

  idempotentPair.add(pairIsIdempotent);
  orderConfirmed.add(pairIsIdempotent);
  orderDuration.add(Math.max(...responses.map((response) => response.timings.duration)));
}
