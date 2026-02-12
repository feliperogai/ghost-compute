// Public surface of the scheduling module.
export * from './types.js';
export * from './catalog.js';
export * from './eligibility.js';
export * from './strategy.js';
export * from './retry.js';
export * from './ports.js';
export * from './engine.js';
export { weightedStrategy, score, DEFAULT_WEIGHTS, type Weights } from './strategies/weighted.js';

import { registerStrategy } from './strategy.js';
import { weightedStrategy } from './strategies/weighted.js';

registerStrategy('weighted', () => weightedStrategy());
