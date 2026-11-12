import { describe, expect, test } from "bun:test";
import { generateKeyPairSync, createVerify } from "node:crypto";
import { Broker } from "../src/broker";
import { normalizeAddress, parseConfig } from "../src/config";
import { GitHub, GitHubError, appJwt, type Runner } from "../src/github";

const base = {
  github: { appId: 42, privateKeyFile: "/secrets/app.pem", org: "dfu-programmer" },
  clients: [{ address: "10.9.0.20", name: "avr-test-hat", labels: ["self-hosted", "linux", "ARM64", "avr-test-hat"] }],
};

describe("config", () => {
  test("fills defaults", () => {
    const c = parseConfig(base);
    expect(c.listen).toEqual({ host: "0.0.0.0", port: 8090 });
    expect(c.github.apiUrl).toBe("https://api.github.com");
    expect(c.minIntervalSeconds).toBe(20);
    expect(c.clients[0]!.runnerGroupId).toBe(1);
  });

  test("rejects what it can't use", () => {
    expect(() => parseConfig({ ...base, clients: [] })).toThrow("clients");
    expect(() => parseConfig({ ...base, clients: [{ ...base.clients[0], address: "10.9.0.256" }] })).toThrow("address");
    expect(() => parseConfig({ ...base, clients: [{ ...base.clients[0], labels: [] }] })).toThrow("labels");
    expect(() => parseConfig({ ...base, clients: [base.clients[0], { ...base.clients[0], name: "other" }] })).toThrow("twice");
    expect(() => parseConfig({ ...base, github: { ...base.github, appId: "42" } })).toThrow("appId");
  });

  test("reads IPv4-mapped IPv6 as IPv4", () => {
    expect(normalizeAddress("::ffff:10.9.0.20")).toBe("10.9.0.20");
    expect(normalizeAddress("10.9.0.20")).toBe("10.9.0.20");
    expect(normalizeAddress("fe80::1")).toBe("fe80::1");
  });
});

describe("GitHub App JWT", () => {
  test("is RS256, signed by the App key, issued by the App", () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const jwt = appJwt(42, privateKey, 1_000_000);
    const [h, p, s] = jwt.split(".");
    expect(JSON.parse(Buffer.from(h!, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
    expect(JSON.parse(Buffer.from(p!, "base64url").toString())).toEqual({ iat: 999_940, exp: 1_000_540, iss: "42" });
    const v = createVerify("RSA-SHA256");
    v.update(`${h}.${p}`);
    expect(v.verify(publicKey, Buffer.from(s!, "base64url"))).toBe(true);
  });
});

describe("GitHub client", () => {
  test("gets an installation token once and reuses it", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const calls: string[] = [];
    const fake = async (url: string, init?: RequestInit) => {
      const path = url.replace("https://api.github.com", "");
      calls.push(`${init?.method} ${path} ${(init?.headers as Record<string, string>).Authorization?.slice(0, 12)}`);
      if (path === "/orgs/o/installation") return Response.json({ id: 7 });
      if (path === "/app/installations/7/access_tokens")
        return Response.json({ token: "ghs_x", expires_at: new Date(Date.now() + 3600_000).toISOString() }, { status: 201 });
      if (path.startsWith("/orgs/o/actions/runners?name=")) return Response.json({ runners: [] });
      return new Response("?", { status: 500 });
    };
    const gh = new GitHub({ apiUrl: "https://api.github.com", appId: 1, org: "o", key: privateKey }, fake);
    await gh.runnersNamed("a");
    await gh.runnersNamed("b");
    expect(calls.filter((c) => c.includes("access_tokens"))).toHaveLength(1);
    expect(calls.at(-1)).toBe("GET /orgs/o/actions/runners?name=b&per_page=100 Bearer ghs_x");
  });

  test("raises GitHub's status on failure", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const gh = new GitHub({ apiUrl: "https://api.github.com", appId: 1, org: "o", key: privateKey }, async () => new Response("nope", { status: 403 }));
    await expect(gh.runnersNamed("a")).rejects.toBeInstanceOf(GitHubError);
  });
});

function setup(runners: Runner[] = [], opts: { fail?: boolean } = {}) {
  const calls: string[] = [];
  const logs: string[] = [];
  let t = 1_000_000;
  const gh = {
    runnersNamed: async (name: string) => {
      calls.push(`list ${name}`);
      if (opts.fail) throw new GitHubError(401, "bad credentials");
      return runners;
    },
    deleteRunner: async (id: number) => void calls.push(`delete ${id}`),
    jitConfig: async (name: string, labels: string[], group: number) => {
      calls.push(`jit ${name} ${labels.join(",")} ${group}`);
      return { runnerId: 99, config: "ENCODED" };
    },
  };
  const broker = new Broker(parseConfig(base), gh, (m) => logs.push(m), () => t);
  const ask = (addr?: string, headers: Record<string, string> = {}) =>
    broker.handle(new Request("http://broker/v1/jitconfig", { headers }), addr);
  return { broker, calls, logs, ask, advance: (ms: number) => (t += ms) };
}

describe("broker", () => {
  test("gives a configured machine its JIT config", async () => {
    const { ask, calls } = setup();
    const res = await ask("10.9.0.20");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ENCODED");
    expect(calls).toEqual(["list avr-test-hat", "jit avr-test-hat self-hosted,linux,ARM64,avr-test-hat 1"]);
  });

  test("knows machines only by source address, never by headers", async () => {
    const { ask, calls } = setup();
    expect((await ask("10.9.0.21", { "X-Forwarded-For": "10.9.0.20", "X-Real-IP": "10.9.0.20" })).status).toBe(403);
    expect((await ask(undefined)).status).toBe(403);
    expect(calls).toEqual([]);
  });

  test("accepts the IPv4-mapped form of the address", async () => {
    expect((await setup().ask("::ffff:10.9.0.20")).status).toBe(200);
  });

  test("removes a leftover registration before making a new one", async () => {
    const { ask, calls } = setup([{ id: 5, name: "avr-test-hat", status: "offline", busy: false }]);
    expect((await ask("10.9.0.20")).status).toBe(200);
    expect(calls).toEqual(["list avr-test-hat", "delete 5", "jit avr-test-hat self-hosted,linux,ARM64,avr-test-hat 1"]);
  });

  test("won't replace a runner that's still busy", async () => {
    const { ask, calls } = setup([{ id: 5, name: "avr-test-hat", status: "online", busy: true }]);
    expect((await ask("10.9.0.20")).status).toBe(409);
    expect(calls).toEqual(["list avr-test-hat"]);
  });

  test("rate-limits each machine", async () => {
    const { ask, advance } = setup();
    expect((await ask("10.9.0.20")).status).toBe(200);
    const again = await ask("10.9.0.20");
    expect(again.status).toBe(429);
    expect(again.headers.get("Retry-After")).toBe("20");
    advance(20_000);
    expect((await ask("10.9.0.20")).status).toBe(200);
  });

  test("reports GitHub failures without leaking them to the machine", async () => {
    const { ask, logs } = setup([], { fail: true });
    const res = await ask("10.9.0.20");
    expect(res.status).toBe(502);
    expect(await res.text()).not.toContain("bad credentials");
    expect(logs.join("\n")).toContain("bad credentials");
  });

  test("serves nothing else", async () => {
    const { broker } = setup();
    expect((await broker.handle(new Request("http://broker/healthz"), "1.2.3.4")).status).toBe(200);
    expect((await broker.handle(new Request("http://broker/v1/other"), "10.9.0.20")).status).toBe(404);
    expect((await broker.handle(new Request("http://broker/v1/jitconfig", { method: "POST" }), "10.9.0.20")).status).toBe(405);
  });
});
