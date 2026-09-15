# Skrytka

Live demo: https://skrytka.radek.sh

Share passwords, tokens and other secrets with people. Skrytka encrypts the message in the sender's browser, stores only the ciphertext and hands the recipient a link that carries the decryption key in its fragment. The server never sees the plaintext or the key, and a note can be read exactly once, or for a limited time, and then it is gone.

**Skrytka** (pronounced *skrit-ka*) is Polish for a small hidden compartment: the locked drawer in a desk, a safe deposit box, or the dead drop where a spy leaves a package for someone else to collect. You put something inside, lock it, and pass the key to the one person who is supposed to open it. That is exactly what this service does.

- **Zero knowledge.** Encryption and decryption happen in the browser with the Web Crypto API. The database holds AES-GCM ciphertext and nothing that could decrypt it.
- **Key in the URL fragment.** Browsers never send the part after `#` to the server, so the key does not land in access logs, proxies or CDNs.
- **Link previews cannot burn a note.** The landing page is static and touches nothing. The ciphertext is fetched only after the recipient clicks a button, so chat clients, mail scanners and sandboxes that follow links do not consume one-time notes.
- **Burn after reading, done atomically.** A one-time note is deleted in the same SQL statement that reads it. Two concurrent readers get exactly one success.
- **Split delivery.** The sender gets the full link and, separately, the bare key. Send the link over one channel and the key over another; the recipient pastes the key into the page.

## Security model

- The server never sees the plaintext or the key. A database leak exposes ciphertext only.
- Keys are per note, 32 random bytes from `crypto.getRandomValues`, 12-byte IV, 128-bit GCM tag.
- The note page `/<uuid>` is static. On load it only asks `/api/notes/<uuid>/info` whether the note is one-time, which never consumes it.
- "Does not exist", "expired" and "already read" all return the same `404`.
- Consuming a one-time note is a single `DELETE ... RETURNING`.
- Strict CSP without inline scripts or styles, `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`, no CORS.

## How it works

1. The sender types a message at `/create`. The browser generates a random 256-bit AES-GCM key, encrypts the text and posts only `{ ciphertext, iv }` (base64url) to the server.
2. The server stores the ciphertext under a random UUID with the chosen lifetime and returns the id.
3. The browser builds the link `https://host/<uuid>#<key>`.
4. The recipient opens the link and sees a welcome screen. If the fragment contains a key it is pre-filled into a password field with a show/hide toggle; otherwise the recipient is asked to paste it. One-time notes show a warning before reading. The ciphertext is not fetched yet.
5. On click the browser fetches the ciphertext, decrypts it locally and shows the text. One-time notes are deleted by that request; the key is also removed from the address bar.

## Running it

Two interchangeable server layers share the same frontend in `public/`.

**Container** (Node.js, SQLite in `/data`): configuration through environment variables, see `.env.example`.

```bash
docker run -d -p 3000:3000 -v skrytka-data:/data ghcr.io/radeksh/skrytka:latest
```

**Cloudflare Workers** (D1, Static Assets): this is how the public instance runs. Per-IP rate limiting and a cron purge of expired notes are configured in `wrangler.jsonc`. On the Workers Free plan there is no overage billing; past the daily limits requests fail instead of generating cost.

```bash
npx wrangler d1 create skrytka        # once; paste database_id into wrangler.jsonc
npx wrangler d1 migrations apply skrytka --remote
npx wrangler deploy
```

Pushes to `main` deploy automatically through `.github/workflows/deploy.yml`, which needs the `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` repository secrets. Wrangler requires Node.js 22.

Creation (`/create`, `POST /api/create`) and reading (`/<uuid>`, `GET /api/notes/<uuid>`) live under disjoint paths on purpose, so access to creation can be restricted by path at a proxy, ingress or Cloudflare WAF rule.

## License

MIT
