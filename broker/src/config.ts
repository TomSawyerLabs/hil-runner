// The broker's configuration: one JSON file, checked strictly at startup.

export interface Client {
  /** The machine's IPv4 address, as the broker sees it (no proxies in between). */
  address: string;
  /** The organization the machine serves. The App must be installed there. */
  org: string;
  /** The runner's name on GitHub. One live registration per name. */
  name: string;
  /** Labels, including the defaults GitHub would give (self-hosted, linux, ARM64). */
  labels: string[];
  /** The runner group to join (1 is the org's Default group). */
  runnerGroupId: number;
}

export interface Config {
  listen: { host: string; port: number };
  /** The App key's file. Optional: GITHUB_APP_PRIVATE_KEY in the environment wins over it. */
  github: { appId: number; privateKeyFile?: string; apiUrl: string };
  /** Seconds a client must wait between requests. */
  minIntervalSeconds: number;
  clients: Client[];
}

const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
// GitHub's rules for runner names and labels are looser; these are what we'll accept.
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function fail(msg: string): never {
  throw new Error(`config: ${msg}`);
}

export function parseConfig(raw: unknown): Config {
  if (typeof raw !== "object" || raw === null) fail("not an object");
  const r = raw as Record<string, any>;

  const listen = r.listen ?? {};
  const host = listen.host ?? "0.0.0.0";
  const port = listen.port ?? 8090;
  if (typeof host !== "string") fail("listen.host must be a string");
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail("listen.port must be a port number");

  const gh = r.github ?? fail("github is required");
  if (!Number.isInteger(gh.appId) || gh.appId < 1) fail("github.appId must be the App's numeric ID");
  if (gh.privateKeyFile !== undefined && (typeof gh.privateKeyFile !== "string" || !gh.privateKeyFile))
    fail("github.privateKeyFile must be a path");
  if (gh.org !== undefined) fail("github.org has moved: give each client its own org");
  const apiUrl = gh.apiUrl ?? "https://api.github.com";
  if (typeof apiUrl !== "string" || !/^https?:\/\//.test(apiUrl)) fail("github.apiUrl must be a URL");

  const minIntervalSeconds = r.minIntervalSeconds ?? 20;
  if (typeof minIntervalSeconds !== "number" || minIntervalSeconds < 0) fail("minIntervalSeconds must be >= 0");

  if (!Array.isArray(r.clients) || r.clients.length === 0) fail("clients must list at least one machine");
  const seenAddr = new Set<string>();
  const seenName = new Set<string>();
  const clients: Client[] = r.clients.map((c: any, i: number) => {
    const at = `clients[${i}]`;
    if (typeof c?.address !== "string" || !IPV4.test(c.address)) fail(`${at}.address must be an IPv4 address`);
    if (typeof c.org !== "string" || !NAME.test(c.org)) fail(`${at}.org must be an organization login`);
    if (typeof c.name !== "string" || !NAME.test(c.name)) fail(`${at}.name must be a runner name`);
    if (!Array.isArray(c.labels) || c.labels.length === 0 || !c.labels.every((l: unknown) => typeof l === "string" && NAME.test(l)))
      fail(`${at}.labels must be a non-empty list of labels`);
    const runnerGroupId = c.runnerGroupId ?? 1;
    if (!Number.isInteger(runnerGroupId) || runnerGroupId < 1) fail(`${at}.runnerGroupId must be a group ID`);
    if (seenAddr.has(c.address)) fail(`${at}.address ${c.address} is listed twice`);
    if (seenName.has(c.name)) fail(`${at}.name ${c.name} is listed twice`);
    seenAddr.add(c.address);
    seenName.add(c.name);
    return { address: c.address, org: c.org, name: c.name, labels: [...c.labels], runnerGroupId };
  });

  return {
    listen: { host, port },
    github: { appId: gh.appId, privateKeyFile: gh.privateKeyFile, apiUrl: apiUrl.replace(/\/+$/, "") },
    minIntervalSeconds,
    clients,
  };
}

/** An IPv4-mapped IPv6 address (::ffff:10.0.0.1) as plain IPv4; anything else unchanged. */
export function normalizeAddress(addr: string): string {
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(addr);
  return m ? m[1]! : addr;
}
