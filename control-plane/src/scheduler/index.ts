// Public surface of the scheduling module.
export * from './types.js';
export * from './catalog.js';
export * from './eligibility.js';
export * from './strategy.js';
export * from './retry.js';
export * from './ports.js';
export * from './engine.js';
export { weightedStrategy, score, DEFAULT_WEIGHTS, type Weights } from './strategies/weighted.js';
export { scoreStrategy, scoreWorker, explain, WEIGHTS_BY_PRIORITY, TERMS } from './strategies/score.js';

import { registerStrategy } from './strategy.js';
import { weightedStrategy } from './strategies/weighted.js';
import { scoreStrategy } from './strategies/score.js';

registerStrategy('score', () => scoreStrategy());
registerStrategy('weighted', () => weightedStrategy());
