// hil-runner broker: BROKER_CONFIG=<file.json> bun src/main.ts
import { readFileSync } from "node:fs";
import { Broker } from "./broker";
import { parseConfig } from "./config";
import { GitHub, keyFromEnv, loadKey } from "./github";

const file = process.env.BROKER_CONFIG ?? "/config/broker.json";
const config = parseConfig(JSON.parse(readFileSync(file, "utf8")));
const fromEnv = process.env.GITHUB_APP_PRIVATE_KEY;
delete process.env.GITHUB_APP_PRIVATE_KEY;
const key = fromEnv
  ? keyFromEnv(fromEnv)
  : config.github.privateKeyFile
    ? loadKey(readFileSync(config.github.privateKeyFile, "utf8"))
    : (() => {
        throw new Error("no App key: set GITHUB_APP_PRIVATE_KEY or github.privateKeyFile");
      })();
const github = new GitHub({ apiUrl: config.github.apiUrl, appId: config.github.appId, key });
const broker = new Broker(config, github);

const server = Bun.serve({
  hostname: config.listen.host,
  port: config.listen.port,
  fetch: (req, srv) => broker.handle(req, srv.requestIP(req)?.address),
});

console.log(
  `hil-runner broker on ${server.hostname}:${server.port}: ` +
    config.clients.map((c) => `${c.org}/${c.name}@${c.address}`).join(", "),
);
