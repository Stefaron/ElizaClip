/**
 * One-time OAuth helper: obtains a YouTube refresh token for the configured
 * Desktop OAuth client. Run once, paste the printed refresh token into .env as
 * YOUTUBE_REFRESH_TOKEN.
 *
 *   bun run scripts/youtube-oauth.ts
 */

import { google } from "googleapis";
import { createServer } from "node:http";
import { URL } from "node:url";

const CLIENT_ID = process.env.YOUTUBE_CLIENT_ID;
const CLIENT_SECRET = process.env.YOUTUBE_CLIENT_SECRET;
const PORT = 4455;
const REDIRECT_URI = `http://127.0.0.1:${PORT}/callback`;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("Missing YOUTUBE_CLIENT_ID / YOUTUBE_CLIENT_SECRET in env.");
  process.exit(1);
}

const oauth2 = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

const authUrl = oauth2.generateAuthUrl({
  access_type: "offline",
  prompt: "consent",
  scope: ["https://www.googleapis.com/auth/youtube.upload"],
});

console.log("\nOpen this URL in your browser and approve:\n");
console.log(authUrl);
console.log(`\nWaiting for redirect on ${REDIRECT_URI} ...\n`);

const server = createServer(async (req, res) => {
  if (!req.url?.startsWith("/callback")) {
    res.writeHead(404).end();
    return;
  }
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const code = url.searchParams.get("code");
  if (!code) {
    res.writeHead(400).end("no code");
    return;
  }
  try {
    const { tokens } = await oauth2.getToken(code);
    res.writeHead(200, { "Content-Type": "text/html" }).end(
      "<h2>Authorized. You can close this tab.</h2>",
    );
    console.log("\n=== SUCCESS ===");
    console.log("Refresh token (paste into .env as YOUTUBE_REFRESH_TOKEN):\n");
    console.log(tokens.refresh_token);
    console.log("\n(access token expires in", tokens.expiry_date, ")");
    server.close();
    process.exit(0);
  } catch (err) {
    console.error("Token exchange failed:", err);
    res.writeHead(500).end("token exchange failed");
    process.exit(1);
  }
});

server.listen(PORT);
