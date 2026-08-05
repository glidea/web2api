type ScheduledTask<T> = {
  id: string;
  key: string;
  execute: (workerId: string) => Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
};

export class ConversationScheduler {
  private readonly maxWorkers: number;
  private readonly workers: Set<string> = new Set<string>();
  private readonly busyWorkers: Set<string> = new Set<string>();
  private readonly locks: Set<string> = new Set<string>();
  private readonly queue: Array<ScheduledTask<unknown>> = [];
  private nextTaskId: number = 0;

  public constructor(maxWorkers: number) {
    this.maxWorkers = maxWorkers;
  }

  public addWorker(workerId: string): void {
    if (this.workers.size < this.maxWorkers) {
      this.workers.add(workerId);
      this.pump();
    }
  }

  public removeWorker(workerId: string): void {
    this.workers.delete(workerId);
    this.busyWorkers.delete(workerId);
    this.pump();
  }

  public enqueue<T>(conversationId: string | undefined, execute: (workerId: string) => Promise<T>): Promise<T> {
    return this.enqueueWithId(`task-${this.nextTaskId}`, conversationId, execute).result;
  }

  public enqueueWithId<T>(id: string, conversationId: string | undefined, execute: (workerId: string) => Promise<T>): { id: string; result: Promise<T> } {
    const key: string = conversationId ?? `new-${this.nextTaskId}`;
    this.nextTaskId += 1;
    const result: Promise<T> = new Promise<T>((resolve, reject): void => {
      this.queue.push({ id, key, execute, resolve: resolve as (value: unknown) => void, reject });
      this.pump();
    });
    return { id, result };
  }

  public cancel(id: string, error: Error): boolean {
    const taskIndex: number = this.queue.findIndex((task: ScheduledTask<unknown>): boolean => task.id === id);
    if (taskIndex < 0) {
      return false;
    }
    const [task]: Array<ScheduledTask<unknown>> = this.queue.splice(taskIndex, 1);
    if (task === undefined) {
      return false;
    }
    task.reject(error);
    return true;
  }

  public close(error: Error): void {
    while (this.queue.length > 0) {
      const task: ScheduledTask<unknown> | undefined = this.queue.shift();
      task?.reject(error);
    }
  }

  public runningCount(): number {
    return this.busyWorkers.size;
  }

  public queueLength(): number {
    return this.queue.length;
  }

  private pump(): void {
    for (const workerId of this.workers) {
      if (this.busyWorkers.has(workerId)) {
        continue;
      }
      const taskIndex: number = this.queue.findIndex((task: ScheduledTask<unknown>): boolean => !this.locks.has(task.key));
      if (taskIndex < 0) {
        continue;
      }
      const task: ScheduledTask<unknown> | undefined = this.queue.splice(taskIndex, 1)[0];
      if (task === undefined) {
        continue;
      }
      this.busyWorkers.add(workerId);
      this.locks.add(task.key);
      void task.execute(workerId).then((value: unknown): void => {
        this.release(workerId, task.key);
        task.resolve(value);
      }).catch((error: unknown): void => {
        this.release(workerId, task.key);
        task.reject(error instanceof Error ? error : new Error(String(error)));
      });
    }
  }

  private release(workerId: string, key: string): void {
    this.busyWorkers.delete(workerId);
    this.locks.delete(key);
    this.pump();
  }
}
