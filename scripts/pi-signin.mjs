#!/usr/bin/env node
/**
 * Local Pi Sign-in helper — gets your app-scoped uid for A2U testing.
 *
 * Pi Sign-in is OAuth 2.0 *implicit* flow, so the token comes back in the URL
 * fragment (#access_token=...). Browsers never send fragments to the server,
 * so a plain listener on /callback would receive nothing. The callback page
 * therefore serves a scrap of JS that reads location.hash and posts it back to
 * this process, which then calls /v2/me.
 *
 * The access token is short-lived and is NOT printed — it is a credential.
 * The /v2/me response is printed in full: it contains no secrets, and its
 * exact shape is the open question behind verify_user's success path.
 *
 * Usage:
 *   node scripts/pi-signin.mjs <oauth-client-id>
 *   PI_OAUTH_CLIENT_ID=... node scripts/pi-signin.mjs
 */
import http from "node:http";
import { spawn } from "node:child_process";

const PORT = Number(process.env.PION_SIGNIN_PORT ?? 3000);
const REDIRECT_URI = `http://localhost:${PORT}/callback`;
const AUTHORIZE_URL = "https://accounts.pinet.com/oauth/authorize";
const PLATFORM_URL = (process.env.PION_PLATFORM_URL ?? "https://api.minepi.com").replace(/\/+$/, "");
const SCOPES = process.env.PION_SIGNIN_SCOPES ?? "username";
const TIMEOUT_MS = 180_000;

const clientId = process.argv[2] ?? process.env.PI_OAUTH_CLIENT_ID;
if (!clientId) {
  console.error("Usage: node scripts/pi-signin.mjs <oauth-client-id>");
  console.error("Find the client ID in the Pi Developer Portal under Pi Sign-in.");
  process.exit(1);
}

const authUrl =
  `${AUTHORIZE_URL}?client_id=${encodeURIComponent(clientId)}` +
  `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
  `&response_type=token&scope=${encodeURIComponent(SCOPES)}`;

/** Minimal page: hand the fragment back to this process, then report. */
const CALLBACK_PAGE = `<!doctype html><meta charset="utf-8"><title>Pi Sign-in</title>
<body style="font:16px system-ui;padding:3rem;max-width:34rem;margin:auto">
<h2 id="s">Completing sign-in…</h2><p id="d"></p>
<script>
  // The token lives in the fragment, which never reached the server.
  fetch("/token", { method: "POST", body: location.hash.slice(1) })
    .then(r => r.text())
    .then(t => { document.getElementById("s").textContent = "Done";
                 document.getElementById("d").textContent = t + " You can close this tab."; })
    .catch(e => { document.getElementById("s").textContent = "Failed";
                  document.getElementById("d").textContent = String(e); });
</script></body>`;

let finished = false;
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (req.method === "GET" && url.pathname === "/callback") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(CALLBACK_PAGE);
    return;
  }

  if (req.method === "POST" && url.pathname === "/token") {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const params = new URLSearchParams(Buffer.concat(chunks).toString());

    const error = params.get("error");
    if (error) {
      const detail = params.get("error_description") ?? "";
      console.error(`\nSign-in was refused: ${error} ${detail}`);
      res.writeHead(200).end("Sign-in refused.");
      return shutdown(1);
    }

    const token = params.get("access_token");
    if (!token) {
      console.error("\nNo access_token in the callback fragment. Raw payload:");
      console.error(`  ${params.toString().slice(0, 300) || "(empty)"}`);
      res.writeHead(200).end("No token found in callback.");
      return shutdown(1);
    }

    const me = await fetch(`${PLATFORM_URL}/v2/me`, {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    });
    const body = await me.text();

    if (!me.ok) {
      console.error(`\n/v2/me failed with HTTP ${me.status}: ${body.slice(0, 300) || "(empty)"}`);
      res.writeHead(200).end("Token obtained, but /v2/me rejected it.");
      return shutdown(1);
    }

    const profile = JSON.parse(body);
    console.log("\n" + "=".repeat(56));
    console.log("YOUR RECIPIENT UID");
    console.log("=".repeat(56));
    console.log(`\n  ${profile.uid}\n`);
    if (profile.username) console.log(`  username: ${profile.username}`);
    console.log("\nFull /v2/me response (no secrets — this is the shape verify_user parses):\n");
    console.log(JSON.stringify(profile, null, 2));
    console.log("\nNext:  node scripts/probe-a2u.mjs " + profile.uid);
    console.log("\n(The access token is deliberately not printed. It is a credential.)");

    res.writeHead(200).end(`Signed in as uid ${profile.uid}.`);
    return shutdown(0);
  }

  res.writeHead(404).end("not found");
});

function shutdown(code) {
  if (finished) return;
  finished = true;
  process.exitCode = code;
  // Let the browser receive its response before tearing the listener down.
  setTimeout(() => server.close(), 250);
}

server.listen(PORT, () => {
  console.log(`Listening on ${REDIRECT_URI}`);
  console.log("This must exactly match the redirect URI registered in the Developer Portal.\n");
  console.log("Opening your browser. If it does not open, visit:\n");
  console.log(`  ${authUrl}\n`);

  // cmd.exe treats & as a command separator, so an un-escaped OAuth URL is
  // silently truncated at the first query parameter and the browser lands on
  // an error page. ^ is cmd's escape character.
  const cmd =
    process.platform === "win32"
      ? ["cmd", ["/c", "start", "", authUrl.replace(/&/g, "^&")]]
      : process.platform === "darwin"
        ? ["open", [authUrl]]
        : ["xdg-open", [authUrl]];
  spawn(cmd[0], cmd[1], { stdio: "ignore", detached: true }).unref();
});

setTimeout(() => {
  if (!finished) {
    console.error(`\nTimed out after ${TIMEOUT_MS / 1000}s with no callback.`);
    shutdown(1);
  }
}, TIMEOUT_MS).unref();
