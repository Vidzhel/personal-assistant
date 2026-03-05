import { EventEmitter } from 'node:events';
import { createLogger } from '@raven/shared';
import type { RavenEvent, RavenEventType } from '@raven/shared';

const log = createLogger('event-bus');

type EventHandler<T = RavenEvent> = (event: T) => void;

export class EventBus {
  private emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(50);
  }

  emit(event: RavenEvent): void {
    log.debug(`Event: ${event.type}`, event.id);
    this.emitter.emit(event.type, event);
    this.emitter.emit('*', event);
  }

  on<T extends RavenEvent = RavenEvent>(
    type: RavenEventType | '*',
    handler: EventHandler<T>,
  ): void {
    this.emitter.on(type, handler as EventHandler);
  }

  off<T extends RavenEvent = RavenEvent>(
    type: RavenEventType | '*',
    handler: EventHandler<T>,
  ): void {
    this.emitter.off(type, handler as EventHandler);
  }

  once<T extends RavenEvent = RavenEvent>(type: RavenEventType, handler: EventHandler<T>): void {
    this.emitter.once(type, handler as EventHandler);
  }

  listenerCount(): number {
    return this.emitter
      .eventNames()
      .reduce((sum, name) => sum + this.emitter.listenerCount(name), 0);
  }

  removeAllListeners(type?: RavenEventType | '*'): void {
    if (type) {
      this.emitter.removeAllListeners(type);
    } else {
      this.emitter.removeAllListeners();
    }
  }
}
