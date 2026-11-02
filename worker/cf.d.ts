// Minimal ambient types for the Workers runtime APIs used here (@cloudflare/workers-types is not installed).
declare module 'cloudflare:workers' {
  export class DurableObject<E = unknown> {
    ctx: DurableObjectState; env: E;
    constructor(ctx: DurableObjectState, env: E);
  }
}
interface DurableObjectState {
  storage: { get<T>(k: string): Promise<T | undefined>; put(k: string, v: unknown): Promise<void>; setAlarm(at: number): Promise<void>; deleteAll(): Promise<void> };
  blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T>;
  acceptWebSocket(ws: WebSocket): void;
  getWebSockets(): WebSocket[];
}
interface DurableObjectNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(url: string, init?: RequestInit): Promise<Response> };
}
interface WebSocket { serializeAttachment(v: unknown): void; deserializeAttachment(): unknown }
declare class WebSocketPair { 0: WebSocket; 1: WebSocket }
interface ResponseInit { webSocket?: WebSocket }
