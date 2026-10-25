import type { LocalAgentEvent } from "@rakazo/contracts";

/** Coalesce optional public summaries before the host assigns durable event sequence numbers. */
export function localAgentActivity(emit: (event: LocalAgentEvent) => Promise<void>) {
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let key = "";
  let summary = "";
  let previous = "";
  let latest = "";
  let lastAt = -Infinity;
  let pending: Promise<void> = Promise.resolve();
  const clear = () => {
    clearTimeout(timer);
    timer = undefined;
    latest = "";
  };
  const publish = (text: string) => {
    if (closed || previous === text) return pending;
    previous = text;
    lastAt = performance.now();
    pending = pending.then(() => emit({ type: "activity", text }));
    // The next protocol boundary still observes the original rejected promise.
    void pending.catch(() => undefined);
    return pending;
  };
  return {
    phase(text: string) {
      clear();
      return publish(text);
    },
    summary(item: string, delta: string) {
      if (closed) return;
      if (item !== key) {
        key = item;
        summary = "";
      }
      // Public summary text is untrusted and bounded independently from the reply stream.
      summary = (summary + delta).slice(0, 2048);
      latest = Array.from(summary, (character) => {
        const code = character.codePointAt(0)!;
        return code < 32 || code === 127 ? " " : character;
      })
        .slice(0, 200)
        .join("");
      if (!latest.trim()) return;
      const delay = Math.max(0, 250 - (performance.now() - lastAt));
      if (!delay) {
        const text = latest;
        latest = "";
        void publish(text);
      } else if (!timer) {
        timer = setTimeout(() => {
          timer = undefined;
          const text = latest;
          latest = "";
          if (text) void publish(text);
        }, delay);
        timer.unref();
      }
    },
    async barrier() {
      clear();
      await pending;
    },
    async close() {
      closed = true;
      clear();
      await pending;
    },
  };
}
