import type { Priority } from '@raven/shared';

export interface QueueItem<T> {
  data: T;
  priority: Priority;
  addedAt: number;
}

const PRIORITY_WEIGHT: Record<Priority, number> = {
  urgent: 0,
  high: 1,
  normal: 2,
  low: 3,
};

export class PriorityQueue<T> {
  private items: QueueItem<T>[] = [];

  enqueue(data: T, priority: Priority): void {
    const item: QueueItem<T> = { data, priority, addedAt: Date.now() };
    const idx = this.items.findIndex(
      (i) => PRIORITY_WEIGHT[i.priority] > PRIORITY_WEIGHT[priority],
    );
    if (idx === -1) {
      this.items.push(item);
    } else {
      this.items.splice(idx, 0, item);
    }
  }

  dequeue(): T | undefined {
    return this.items.shift()?.data;
  }

  peek(): T | undefined {
    return this.items[0]?.data;
  }

  get length(): number {
    return this.items.length;
  }

  isEmpty(): boolean {
    return this.items.length === 0;
  }
}
