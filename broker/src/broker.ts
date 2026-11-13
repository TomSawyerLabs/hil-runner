// The request handler. A machine asks GET /v1/jitconfig; the broker knows it only by the
// address the request came from, never by anything in the request.

import { normalizeAddress, type Client, type Config } from "./config";
import { GitHubError, type GitHub } from "./github";

type Log = (msg: string) => void;

export class Broker {
  private readonly byAddress: Map<string, Client>;
  private readonly lastAsked = new Map<string, number>();
  private readonly inFlight = new Set<string>();

  constructor(
    private readonly config: Config,
    private readonly github: Pick<GitHub, "runnersNamed" | "deleteRunner" | "jitConfig">,
    private readonly log: Log = (m) => console.log(m),
    private readonly now: () => number = Date.now,
  ) {
    this.byAddress = new Map(config.clients.map((c) => [c.address, c]));
  }

  async handle(req: Request, remoteAddress: string | undefined): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/healthz") return text(200, "ok\n");
    if (url.pathname !== "/v1/jitconfig") return text(404, "not found\n");
    if (req.method !== "GET") return text(405, "GET only\n");

    const addr = remoteAddress ? normalizeAddress(remoteAddress) : "";
    const client = this.byAddress.get(addr);
    if (!client) {
      this.log(`refused ${addr || "an unknown address"}: not a configured machine`);
      return text(403, "this address isn't a configured machine\n");
    }

    if (this.inFlight.has(client.name)) return text(429, "already handling a request for this machine\n");
    const last = this.lastAsked.get(client.name);
    const wait = last === undefined ? 0 : last + this.config.minIntervalSeconds * 1000 - this.now();
    if (wait > 0) {
      return new Response(`too soon; try again in ${Math.ceil(wait / 1000)} s\n`, {
        status: 429,
        headers: { "Retry-After": String(Math.ceil(wait / 1000)), "Content-Type": "text/plain" },
      });
    }

    this.inFlight.add(client.name);
    this.lastAsked.set(client.name, this.now());
    try {
      // One live registration per machine. A machine asking again has rebooted, so any
      // runner still under its name is a leftover: remove it before making the new one.
      for (const old of await this.github.runnersNamed(client.org, client.name)) {
        if (old.busy) {
          this.log(`${client.name} (${addr}): runner ${old.id} is still busy on GitHub; not replacing it`);
          return text(409, "a runner with this machine's name is still running a job\n");
        }
        await this.github.deleteRunner(client.org, old.id);
        this.log(`${client.name} (${addr}): removed leftover runner ${old.id} (${old.status})`);
      }
      const { runnerId, config } = await this.github.jitConfig(client.org, client.name, client.labels, client.runnerGroupId);
      this.log(`${client.name} (${addr}): issued a JIT config for runner ${runnerId}`);
      return text(200, config);
    } catch (e) {
      const status = e instanceof GitHubError ? e.status : 0;
      this.log(`${client.name} (${addr}): GitHub call failed: ${(e as Error).message}`);
      return text(502, `GitHub refused (${status || "no response"}); see the broker's log\n`);
    } finally {
      this.inFlight.delete(client.name);
    }
  }
}

function text(status: number, body: string): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/plain", "Cache-Control": "no-store" } });
}
