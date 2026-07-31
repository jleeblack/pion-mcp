#!/usr/bin/env node
/**
 * Serves the Pi Browser authorization page.
 *
 * The Pi Browser must be able to reach this over the network, and the URL
 * must match one registered for your app in the Developer Portal — the SDK
 * refuses to initialise otherwise. Binds to 0.0.0.0 and prints the LAN
 * address so a phone on the same network can load it directly; if your app
 * is registered against a public https URL, put a tunnel in front instead.
 *
 * Usage:
 *   node scripts/browser-auth/serve.mjs [port]
 */
import http from "node:http";
import { readFile } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.argv[2] ?? process.env.PORT ?? 8080);

const page = await readFile(join(here, "index.html"));

const server = http.createServer((req, res) => {
  if (req.url === "/" || req.url?.startsWith("/index.html")) {
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      // The page must never be cached between attempts, or a stale copy can
      // silently hide a scope change.
      "cache-control": "no-store",
    });
    res.end(page);
    return;
  }
  if (req.url === "/validation-key.txt" && process.env.PI_VALIDATION_KEY) {
    // The portal's domain-verification check fetches this path.
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(process.env.PI_VALIDATION_KEY);
    return;
  }
  res.writeHead(404).end("not found");
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Serving the Pi Browser authorization page on port ${PORT}.\n`);
  console.log("Reachable at:");
  console.log(`  http://localhost:${PORT}/   (this machine only)`);
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === "IPv4" && !a.internal) {
        console.log(`  http://${a.address}:${PORT}/   (${name} — try this from your phone)`);
      }
    }
  }
  console.log(`
Open it INSIDE the Pi Browser, not a normal browser — the page will tell you
if the SDK failed to load. The URL must be one registered for your app in the
Developer Portal; the SDK will not initialise on an unregistered origin.

If your app is registered against a public https URL, front this with a tunnel
(cloudflared, ngrok) and open the tunnel URL instead. Set PI_VALIDATION_KEY if
the portal asks you to serve /validation-key.txt for domain verification.

Ctrl-C when finished.`);
});
