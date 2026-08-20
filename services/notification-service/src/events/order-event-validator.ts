import { readFile } from 'node:fs/promises';

import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';

import type { OrderEventV1 } from './order-event.js';

export async function createOrderEventValidator(): Promise<
  ValidateFunction<OrderEventV1>
> {
  const schemaPath = new URL(
    '../../../../contracts/events/order-event.v1.schema.json',
    import.meta.url,
  );
  const schema = JSON.parse(await readFile(schemaPath, 'utf8')) as object;
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  ajv.addFormat('date-time', {
    type: 'string',
    validate: (value: string) => !Number.isNaN(Date.parse(value)),
  });
  return ajv.compile<OrderEventV1>(schema);
}
