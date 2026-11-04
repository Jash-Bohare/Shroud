import { EventEmitter } from "node:events";
import { Actor, Status } from "../shared/types.js";

export interface ShroudEventPayload {
  id?: number;
  purchaseId: string | null;
  type: string;
  fromStatus: Status | null;
  toStatus: Status | null;
  actor: Actor;
  data: Record<string, unknown>;
  simulated: boolean;
  createdAt: string;
}

class ShroudEventBus extends EventEmitter {
  emitEvent(event: ShroudEventPayload): void {
    this.emit("event", event);
    if (event.toStatus) {
      this.emit(`status:${event.toStatus}`, event);
    }
    if (event.type) {
      this.emit(event.type, event);
    }
  }
}

export const eventBus = new ShroudEventBus();

