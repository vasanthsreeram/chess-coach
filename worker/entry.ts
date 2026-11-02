// Deployed Worker entry: the HTTP handler plus the Durable Object class (kept apart so Node tests can import index.ts).
export { default } from './index';
export { ChessRoom } from './room';
