import { afterEach, expect, it, vi } from "vitest";
import { LocalAgentSessionPool } from "./local-agent-session-pool.js";

afterEach(() => vi.useRealTimers());
const resource = () => ({ close: vi.fn(async () => {}) });

it("expires idle resources and evicts the least recently returned one within the capacity", async () => {
  vi.useFakeTimers({ toFake: ["performance", "setTimeout", "clearTimeout"] });
  const pool = new LocalAgentSessionPool(1000, 2);
  const a = resource(),
    b = resource(),
    c = resource();
  await pool.put("a", "a", 0, a);
  await pool.put("b", "b", 0, b);
  expect(await pool.take("a")).toBe(a);
  await pool.put("a", "a", 0, a);
  await pool.put("c", "c", 0, c);
  expect(b.close).toHaveBeenCalledOnce();
  expect(await pool.take("b")).toBeUndefined();
  await vi.advanceTimersByTimeAsync(1000);
  expect(a.close).toHaveBeenCalledOnce();
  expect(c.close).toHaveBeenCalledOnce();
  expect(await pool.take("a")).toBeUndefined();
  await pool.close();
});

it("fences a released generation even when a turn finishes later", async () => {
  const pool = new LocalAgentSessionPool();
  const old = resource(),
    next = resource();
  const generation = pool.generation("binding");
  await pool.release("binding");
  await pool.put("old", "binding", generation, old);
  expect(await pool.take("old")).toBeUndefined();
  expect(old.close).toHaveBeenCalledOnce();
  await pool.put("new", "binding", pool.generation("binding"), next);
  expect(await pool.take("new")).toBe(next);
  await next.close();
  await pool.close();
});

it("serializes concurrent returns and disposes resources returned after shutdown", async () => {
  const pool = new LocalAgentSessionPool(1000, 1);
  const a = resource(),
    b = resource(),
    c = resource();
  await Promise.all([pool.put("a", "a", 0, a), pool.put("b", "b", 0, b)]);
  expect(a.close).toHaveBeenCalledOnce();
  await pool.close();
  expect(b.close).toHaveBeenCalledOnce();
  await pool.put("c", "c", 0, c);
  expect(c.close).toHaveBeenCalledOnce();
  await expect(pool.take("c")).rejects.toThrow("closed");
});
