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
// Defaults to 3000 to match the portal's own development-URL example, so the
// registered URL and this server agree without extra configuration.
const PORT = Number(process.argv[2] ?? process.env.PORT ?? 3000);

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
TWO WAYS TO USE THIS

  Sandbox (easiest — desktop browser, no phone):
    1. Developer Portal checklist step 5: set the development URL to
         http://localhost:${PORT}
    2. Step 6: open the portal's sandbox link in this desktop browser, then
       enter the code it gives you in Pi app -> menu -> Utilities.
    3. That browser is now paired with your Pi account. Load
         http://localhost:${PORT}/
       and click Authenticate. Sandbox mode is on automatically for localhost.

  Production (Pi Browser on your phone):
    Requires checklist steps 7-8 (production URL + domain validation). Front
    this with a tunnel, register that https URL, then open it in the Pi
    Browser. Add ?sandbox=0 to force production mode.
    Set PI_VALIDATION_KEY to serve /validation-key.txt for step 8.

Ctrl-C when finished.`);
});
