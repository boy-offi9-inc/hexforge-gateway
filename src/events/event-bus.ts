import { EventEmitter } from "node:events";
import type { EventMap, EventName } from "./types.js";

/**
 * Central Event Bus: modules communicate through events rather than
 * direct calls. Every module imports this
 * singleton instead of reaching into another module's internals - e.g.
 * the WebSocket gateway subscribes to "mcp.task.updated" instead of
 * holding a reference to the MCP orchestrator itself.
 *
 * Intentionally a thin, in-process, in-memory wrapper around Node's
 * EventEmitter for now. If HexForge ever needs cross-process delivery
 * (multiple Gateway instances sharing state), this is the seam where a
 * Redis-backed pub/sub implementation would slot in without changing any
 * calling code - everything already goes through eventBus.emit/on/off.
 */
class EventBus {
  private emitter = new EventEmitter();

  constructor() {
    // Every /ws connection subscribes to each event exactly once (and
    // unsubscribes on close - see core/websocket.ts), so "many listeners
    // on one event" is the normal, intended shape of this broadcast
    // design, not a leak. Node's default cap of 10 exists to catch actual
    // leaks elsewhere; here it would just print a false-positive
    // MaxListenersExceededWarning once an 11th client connects. Uncapped
    // is safe specifically because every subscriber is paired with a
    // corresponding .off() on disconnect.
    this.emitter.setMaxListeners(0);
  }

  emit<K extends EventName>(event: K, payload: EventMap[K]): void {
    this.emitter.emit(event, payload);
  }

  on<K extends EventName>(event: K, listener: (payload: EventMap[K]) => void): void {
    this.emitter.on(event, listener);
  }

  off<K extends EventName>(event: K, listener: (payload: EventMap[K]) => void): void {
    this.emitter.off(event, listener);
  }
}

export const eventBus = new EventBus();
