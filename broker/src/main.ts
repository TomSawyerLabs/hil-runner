// hil-runner broker: BROKER_CONFIG=<file.json> bun src/main.ts
import { readFileSync } from "node:fs";
import { Broker } from "./broker";
import { parseConfig } from "./config";
import { GitHub, loadKey } from "./github";

const file = process.env.BROKER_CONFIG ?? "/config/broker.json";
const config = parseConfig(JSON.parse(readFileSync(file, "utf8")));
const key = loadKey(readFileSync(config.github.privateKeyFile, "utf8"));
const github = new GitHub({ apiUrl: config.github.apiUrl, appId: config.github.appId, org: config.github.org, key });
const broker = new Broker(config, github);

const server = Bun.serve({
  hostname: config.listen.host,
  port: config.listen.port,
  fetch: (req, srv) => broker.handle(req, srv.requestIP(req)?.address),
});

console.log(
  `hil-runner broker on ${server.hostname}:${server.port} for org ${config.github.org}: ` +
    config.clients.map((c) => `${c.name}@${c.address}`).join(", "),
);
