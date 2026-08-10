import os from "node:os";
import { pathToFileURL } from "node:url";

import { createPanelServer, resolveHost, resolvePort } from "./app.mjs";

export {
  createPanelServer,
  resolveHost,
  resolvePort,
  resolveServerOptions,
} from "./app.mjs";

async function main() {
  const app = createPanelServer();
  const host = resolveHost();
  const configuredListenFd = process.env.CODEX_PANEL_LISTEN_FD
    ?? process.env.CODEX_TASKBOARD_LISTEN_FD;
  const listenFd = configuredListenFd === undefined ? null : Number(configuredListenFd);
  const address = await app.listen({ host, port: resolvePort(), fd: listenFd });
  console.log(`Codex Panel listening on http://127.0.0.1:${address.port}`);
  if (host === "0.0.0.0") {
    const addresses = Object.values(os.networkInterfaces())
      .flat()
      .filter((entry) => entry?.family === "IPv4" && !entry.internal)
      .map((entry) => entry.address);
    for (const lanAddress of [...new Set(addresses)]) {
      console.log(`Codex Panel available on LAN at http://${lanAddress}:${address.port}`);
    }
  }

  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await app.close();
  };
  process.once("SIGINT", () => close().then(() => process.exit(0)));
  process.once("SIGTERM", () => close().then(() => process.exit(0)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
