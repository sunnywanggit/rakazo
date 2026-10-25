import type { LocalAgentStart } from "@rakazo/contracts";
import {
  LocalAgentCancelSchema,
  LocalAgentCapabilitiesSchema,
  LocalAgentDecisionSchema,
  LocalAgentEnvelopeSchema,
  LocalAgentLifecycleSchema,
  LocalAgentReleaseSchema,
  LocalAgentStatusSchema,
} from "@rakazo/contracts";
import { createSafeRemoteFetch } from "./remote-mcp.js";

export class LocalAgentBusyError extends Error {}
export class LocalAgentTransportError extends Error {}
export class LocalAgentRequestError extends Error {
  constructor(readonly status: number) {
    super(`Local agent request failed (${status})`);
  }
}

/** Deployment-owned origins are a narrow network grant, independent of MCP policy. */
export function localAgentAllowedOrigins(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => {
      const url = new URL(value);
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.pathname !== "/" ||
        url.search ||
        url.hash
      )
        throw new Error("Invalid local agent origin");
      return url.origin;
    });
}

export class LocalAgentClient {
  private readonly transport = createSafeRemoteFetch(undefined, undefined, {
    allowPrivateEndpoint: true,
  });
  private readonly origin: string;
  constructor(
    private readonly options: { endpoint: string; token: string; allowedOrigins: string[] },
  ) {
    const origins = localAgentAllowedOrigins(options.endpoint);
    const [origin] = origins;
    if (
      origins.length !== 1 ||
      !origin ||
      !options.allowedOrigins.includes(origin) ||
      !/^[a-f0-9]{64}$/.test(options.token)
    )
      throw new Error("Local agent connection is not authorized");
    this.origin = origin;
  }
  private async fetch(
    route: string,
    data?: unknown,
    signal?: AbortSignal,
    stream = false,
    headers: Record<string, string> = {},
  ) {
    const response = await this.transport(new URL(route, this.origin), {
      method: data === undefined ? "GET" : "POST",
      headers: {
        authorization: `Bearer ${this.options.token}`,
        "content-type": "application/json",
        ...headers,
      },
      body: data === undefined ? undefined : JSON.stringify(data),
      signal: stream
        ? signal
        : AbortSignal.any([AbortSignal.timeout(15_000), ...(signal ? [signal] : [])]),
    }).catch(() => {
      throw new LocalAgentTransportError("Local agent connection interrupted");
    });
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 423) throw new LocalAgentBusyError("Local project is busy");
      if (response.status >= 500) throw new LocalAgentTransportError("Local agent unavailable");
      throw new LocalAgentRequestError(response.status);
    }
    return response;
  }
  async capabilities() {
    return LocalAgentCapabilitiesSchema.parse(await (await this.fetch("/v1/capabilities")).json());
  }
  async start(request: LocalAgentStart, signal?: AbortSignal) {
    const lifecycle = await this.lifecycle();
    return LocalAgentStatusSchema.parse(
      await (
        await this.fetch(
          "/v1/runs",
          request,
          signal,
          false,
          lifecycle.sessionReuse ? { "Rakazo-Session-Reuse": "1" } : {},
        )
      ).json(),
    );
  }
  async lifecycle() {
    try {
      return LocalAgentLifecycleSchema.parse(await (await this.fetch("/v1/lifecycle")).json());
    } catch (error) {
      if (error instanceof LocalAgentRequestError && error.status === 404)
        return { sessionReuse: false, sessionRelease: false };
      throw error;
    }
  }
  async release(input: unknown) {
    const value = LocalAgentReleaseSchema.parse(input);
    if (!(await this.lifecycle()).sessionRelease) return;
    const result = await (await this.fetch("/v1/sessions/release", value)).json();
    if (result?.released !== true) throw new Error("Local session release was not confirmed");
  }
  async status(id: string) {
    return LocalAgentStatusSchema.parse(
      await (await this.fetch(`/v1/runs/${encodeURIComponent(id)}`)).json(),
    );
  }
  async heartbeat(id: string, fence: number) {
    await this.fetch(`/v1/runs/${encodeURIComponent(id)}/heartbeat`, { fence });
  }
  async cancel(id: string, fence: number) {
    return LocalAgentStatusSchema.parse(
      await (await this.fetch(`/v1/runs/${encodeURIComponent(id)}/cancel`, { fence })).json(),
    );
  }
  async stop(request: unknown) {
    return LocalAgentStatusSchema.parse(
      await (await this.fetch("/v1/cancellations", LocalAgentCancelSchema.parse(request))).json(),
    );
  }
  async respond(id: string, interactionId: string, decision: unknown) {
    return LocalAgentStatusSchema.parse(
      await (
        await this.fetch(
          `/v1/runs/${encodeURIComponent(id)}/interactions/${encodeURIComponent(interactionId)}`,
          LocalAgentDecisionSchema.parse(decision),
        )
      ).json(),
    );
  }
  async *events(id: string, cursor: number, signal?: AbortSignal) {
    const response = await this.fetch(
      `/v1/runs/${encodeURIComponent(id)}/events?after=${cursor}`,
      undefined,
      signal,
      true,
    );
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Local agent event stream is missing");
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const next = await Promise.race([
          reader.read().catch(() => {
            throw new LocalAgentTransportError("Local event stream interrupted");
          }),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new LocalAgentTransportError("Local agent event stream timed out")),
              45_000,
            );
            timer.unref();
          }),
        ]).finally(() => clearTimeout(timer));
        if (next.done) {
          buffer += decoder.decode();
          if (buffer.trim()) throw new Error("Incomplete local agent event");
          break;
        }
        buffer += decoder.decode(next.value, { stream: true });
        while (buffer.includes("\n")) {
          const lineEnd = buffer.indexOf("\n");
          if (lineEnd > 1_000_000) throw new Error("Local agent event exceeds capacity");
          const line = buffer.slice(0, lineEnd);
          buffer = buffer.slice(lineEnd + 1);
          if (!line.trim()) continue;
          const event = LocalAgentEnvelopeSchema.parse(JSON.parse(line));
          if (event.sequence <= cursor) continue;
          if (event.sequence !== cursor + 1) throw new Error("Local agent event cursor gap");
          cursor = event.sequence;
          yield event;
        }
        if (buffer.length > 1_000_000) throw new Error("Local agent event exceeds capacity");
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  }
  close() {
    return this.transport.close();
  }
}
