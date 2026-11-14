// GitHub App authentication and the three runner calls the broker makes.
// The App needs one permission: Organization > Self-hosted runners: Read and write.
// One App serves every org it's installed on; each org gets its own installation token.

import { createPrivateKey, createSign, type KeyObject } from "node:crypto";

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");

/** A GitHub App JWT: valid from a minute ago (clock skew) for nine minutes. */
export function appJwt(appId: number, key: KeyObject, nowSeconds = Math.floor(Date.now() / 1000)): string {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ iat: nowSeconds - 60, exp: nowSeconds + 9 * 60, iss: String(appId) }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  return `${header}.${payload}.${b64url(signer.sign(key))}`;
}

export function loadKey(pem: string): KeyObject {
  // GitHub hands out PKCS#1 ("BEGIN RSA PRIVATE KEY"); node:crypto reads that and PKCS#8.
  return createPrivateKey(pem);
}

/** The key as an env value: the PEM itself, or (since env files hold one line) its base64. */
export function keyFromEnv(value: string): KeyObject {
  const v = value.trim();
  return loadKey(v.startsWith("-----BEGIN") ? v : Buffer.from(v, "base64").toString("utf8"));
}

export class GitHubError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface Runner {
  id: number;
  name: string;
  status: string;
  busy: boolean;
}

export class GitHub {
  private readonly tokens = new Map<string, { value: string; expires: number }>();

  constructor(
    private readonly opts: { apiUrl: string; appId: number; key: KeyObject },
    private readonly fetch: Fetch = globalThis.fetch,
    private readonly now: () => number = Date.now,
  ) {}

  private async call(method: string, path: string, auth: string, body?: unknown): Promise<any> {
    const res = await this.fetch(`${this.opts.apiUrl}${path}`, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: auth,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "hil-runner-broker",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new GitHubError(res.status, `${method} ${path}: ${res.status} ${text.slice(0, 300)}`);
    }
    return res.status === 204 ? null : res.json();
  }

  /** An installation token for the org, reused until five minutes before it expires. */
  private async auth(org: string): Promise<string> {
    const cached = this.tokens.get(org);
    if (cached && cached.expires - 5 * 60_000 > this.now()) return `Bearer ${cached.value}`;
    const jwt = `Bearer ${appJwt(this.opts.appId, this.opts.key, Math.floor(this.now() / 1000))}`;
    const inst = await this.call("GET", `/orgs/${org}/installation`, jwt);
    const tok = await this.call("POST", `/app/installations/${inst.id}/access_tokens`, jwt, {});
    this.tokens.set(org, { value: tok.token, expires: Date.parse(tok.expires_at) });
    return `Bearer ${tok.token}`;
  }

  async runnersNamed(org: string, name: string): Promise<Runner[]> {
    const auth = await this.auth(org);
    const r = await this.call("GET", `/orgs/${org}/actions/runners?name=${encodeURIComponent(name)}&per_page=100`, auth);
    return (r.runners as Runner[]).filter((x) => x.name === name);
  }

  async deleteRunner(org: string, id: number): Promise<void> {
    await this.call("DELETE", `/orgs/${org}/actions/runners/${id}`, await this.auth(org));
  }

  async jitConfig(org: string, name: string, labels: string[], runnerGroupId: number): Promise<{ runnerId: number; config: string }> {
    const r = await this.call("POST", `/orgs/${org}/actions/runners/generate-jitconfig`, await this.auth(org), {
      name,
      runner_group_id: runnerGroupId,
      labels,
      work_folder: "_work",
    });
    return { runnerId: r.runner.id, config: r.encoded_jit_config };
  }
}
