import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test } from '@playwright/test';
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';

interface EventCase {
  eventType: string;
  status: string;
  failureCode: string | null;
}

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
);
let validate: ValidateFunction;

function eventFor({ eventType, status, failureCode }: EventCase) {
  return {
    eventId: randomUUID(),
    eventType,
    eventVersion: 1,
    occurredAt: new Date().toISOString(),
    correlationId: `correlation-${randomUUID()}`,
    orderId: randomUUID(),
    data: {
      status,
      sku: 'ORDER-EVENT-CONTRACT-001',
      quantity: 2,
      amountInCents: 5990,
      currency: 'BRL',
      failureCode,
    },
  };
}

test.beforeAll(async () => {
  const schema = JSON.parse(
    await readFile(
      path.join(
        repositoryRoot,
        'contracts',
        'events',
        'order-event.v1.schema.json',
      ),
      'utf8',
    ),
  ) as object;
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  ajv.addFormat('date-time', {
    type: 'string',
    validate: (value: string) => !Number.isNaN(Date.parse(value)),
  });
  validate = ajv.compile(schema);
});

const validCases: readonly EventCase[] = [
  {
    eventType: 'ORDER_CONFIRMED',
    status: 'CONFIRMED',
    failureCode: null,
  },
  {
    eventType: 'ORDER_INVENTORY_REJECTED',
    status: 'INVENTORY_REJECTED',
    failureCode: 'INVENTORY_ITEM_NOT_FOUND',
  },
  {
    eventType: 'ORDER_PAYMENT_DECLINED',
    status: 'PAYMENT_DECLINED',
    failureCode: 'CARD_DECLINED',
  },
  {
    eventType: 'ORDER_COMPENSATION_FAILED',
    status: 'COMPENSATION_FAILED',
    failureCode: 'INVENTORY_COMPENSATION_FAILED',
  },
];

for (const eventCase of validCases) {
  test(`accepts ${eventCase.eventType}`, () => {
    expect(validate(eventFor(eventCase))).toBe(true);
    expect(validate.errors).toBeNull();
  });
}

const invalidCases = [
  {
    title: 'rejects a missing eventId',
    mutate: (event: Record<string, unknown>) => delete event.eventId,
  },
  {
    title: 'rejects an unsupported eventVersion',
    mutate: (event: Record<string, unknown>) => {
      event.eventVersion = 2;
    },
  },
  {
    title: 'rejects an unknown eventType',
    mutate: (event: Record<string, unknown>) => {
      event.eventType = 'ORDER_UNKNOWN';
    },
  },
  {
    title: 'rejects an invalid quantity',
    mutate: (event: Record<string, unknown>) => {
      (event.data as Record<string, unknown>).quantity = 0;
    },
  },
  {
    title: 'rejects an additional property',
    mutate: (event: Record<string, unknown>) => {
      event.paymentToken = 'must-not-be-accepted';
    },
  },
  {
    title: 'rejects a non-object data payload',
    mutate: (event: Record<string, unknown>) => {
      event.data = 'invalid';
    },
  },
] as const;

for (const invalidCase of invalidCases) {
  test(invalidCase.title, () => {
    const event = eventFor(validCases[0]!) as Record<string, unknown>;
    invalidCase.mutate(event);
    expect(validate(event)).toBe(false);
    expect(validate.errors).not.toBeNull();
  });
}
