export interface ToolCallLifetime {
  isOpen(): boolean;
  tryEnter(): (() => void) | undefined;
  close(): void;
  /** Close admission first to guarantee no new work arrives while draining. */
  drain(): Promise<void>;
}

export function createToolCallLifetime(assertCurrent?: () => void): ToolCallLifetime {
  let open = true;
  let admitted = 0;
  let drained: Promise<void> | undefined;
  let resolveDrain: (() => void) | undefined;

  const finishDrain = (): void => {
    if (admitted !== 0 || resolveDrain === undefined) return;
    resolveDrain();
    resolveDrain = undefined;
    drained = undefined;
  };

  return {
    isOpen: () => open,

    tryEnter(): (() => void) | undefined {
      if (!open) return undefined;
      try {
        assertCurrent?.();
      } catch {
        open = false;
        return undefined;
      }
      admitted += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        admitted -= 1;
        finishDrain();
      };
    },

    close(): void {
      open = false;
      finishDrain();
    },

    drain(): Promise<void> {
      if (admitted === 0) return Promise.resolve();
      if (drained === undefined) {
        drained = new Promise<void>((resolve) => {
          resolveDrain = resolve;
        });
      }
      return drained;
    },
  };
}
