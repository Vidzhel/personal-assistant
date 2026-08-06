export interface EventBusInterface {
  emit(event: unknown): void;
  on(type: string, handler: (event: unknown) => void): void;
  off(type: string, handler: (event: unknown) => void): void;
}

export interface DatabaseInterface {
  run(sql: string, ...params: unknown[]): void;
  get<T>(sql: string, ...params: unknown[]): T | undefined;
  all<T>(sql: string, ...params: unknown[]): T[];
}

export interface LoggerInterface {
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
  debug(msg: string, ...args: unknown[]): void;
}
