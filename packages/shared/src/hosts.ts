/**
 * Closed pool of host identifiers — the "universe" of `host` column
 * values that producer / aggregator / web all bind to. Declaring `as
 * const` gives downstream `partitionBy('host')` and host-filter UIs
 * a fixed set to type against.
 */
export const HOSTS = [
  'api-1',
  'api-2',
  'api-3',
  'api-4',
  'api-5',
  'api-6',
  'api-7',
  'api-8',
] as const;

export type HostId = (typeof HOSTS)[number];
