export const performanceProducts = [
  {
    sku: 'PERF-ORDER-001',
    name: 'Performance Order Load Product',
    totalQuantity: 10000,
  },
  {
    sku: 'PERF-ORDER-002',
    name: 'Performance Order Concurrency Product',
    totalQuantity: 10000,
  },
];

export const performanceSkus = {
  order: performanceProducts[0].sku,
  concurrency: performanceProducts[1].sku,
};
