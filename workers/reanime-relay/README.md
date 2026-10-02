# Reanime metadata relay (Cloudflare Workers Free)

Vercel sends authenticated metadata requests to this Worker. The Worker calls fixed public Reanime APIs for search, detail, episodes and player addresses. The browser loads FlixCloud directly; video, subtitle files, site sessions and database data do not pass through the Worker. The existing subtitle overlay remains in the app.

## Deploy

1. Create `anihub-reanime-relay` in Cloudflare Workers & Pages using Hello World. In **Edit code**, replace the starter with `worker.mjs` and deploy. Alternatively, use the official Wrangler CLI from this directory: `npx wrangler deploy`.
2. In **Settings → Runtime → Placement**, choose **Region → Amazon Web Services (AWS) → ap-east-1** and deploy. This is a Cloudflare placement hint near Hong Kong, not an AWS resource or account. Wrangler applies the same setting from `wrangler.jsonc`. Default placement produced upstream HTTP 403 through the deployed Vercel route; after this change the route returned HTTP 200. A Playground success alone did not establish production connectivity.
3. In **Settings → Variables and Secrets**, add a **Secret** named `REANIME_WORKER_TOKEN`, using a unique random value of at least 32 characters. Keep it private; do not put it in Git or a `NEXT_PUBLIC_*` variable. Without this secret the Worker returns 503 and never calls Reanime.
4. In Vercel's project environment variables, set:
   - `REANIME_WORKER_URL`: the Worker's HTTPS origin, for example `https://anihub-reanime-relay.example.workers.dev` (no `/resolve` path).
   - `REANIME_WORKER_TOKEN`: the same secret value.
5. Deploy the app revision containing the server transport. Environment-variable changes require a new Vercel deployment. Configure both Preview and Production if both will be used.
6. `GET /health` reports `configured: true` once the secret is present. This only verifies configuration. Then test search, episode loading, playback with/without Korean subtitles and seeking on the actual iPad. Placement is not a guarantee against future upstream restrictions.

## Boundaries

- Only `POST /resolve` with a valid bearer token can contact Reanime. Its JSON body is exactly `{ "path": "/api/flix/178789/14" }` or another allowed metadata path. Arbitrary hosts, login endpoints and redirects are rejected.
- The token is kept on Vercel and Cloudflare, never sent to Reanime or the browser. Authentication is separate from the app's user session.
- Responses have a 4 MB limit and an 8 second upstream timeout. Only JSON responses are relayed; upstream cookies are stripped. HTML challenges and HTTP failures remain errors.
- The Free plan currently allows 100,000 requests per day per account and 10 ms CPU per request; network wait time does not count as CPU. No KV, R2, database or paid add-on is required. Check deployed CPU metrics before treating the Free plan as runtime-verified.
- Public API availability can change. Playground success does not prove every deployment or iPad works. Do not describe the app as restored until the deployed app is tested.
- Removing **both** Vercel environment variables restores the old direct-server/optional desktop-extension route on the next deployment. A partially configured relay fails closed instead of silently sending the secret elsewhere.

Official docs: https://developers.cloudflare.com/workers/get-started/dashboard/ , https://developers.cloudflare.com/workers/platform/limits/ , https://developers.cloudflare.com/workers/configuration/placement/
