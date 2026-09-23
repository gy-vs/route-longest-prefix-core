export {
  FAMILY_BITS,
  FAMILY_BYTES,
  convertMappedAddress,
  convertMappedPrefix,
  formatAddress,
  formatPrefix,
  isIPv4Mapped,
  normalizeAddress,
  normalizePrefix,
  parseAddress,
  parsePrefix,
} from './ip.js';
export type { Address, Family, MappedOptions, Prefix } from './ip.js';
export { PrefixTable } from './table.js';
export type { LookupResult, MatchedPrefix } from './table.js';
