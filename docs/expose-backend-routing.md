# Public routing for the Postgres backend (review/intel API) — DEPLOYED

The Chrome extension's **review** feature talks to the TypeScript/Postgres
backend (`backend/`, container port **3001**) via:

- `POST /api/auth/...`        — login + `zx_` key provisioning
- `POST /api/ingest/intel`    — push scraped review snapshots + reviews
- `GET  /api/ingest/intel`    — read review data back for the dashboard

## What is live now

The backend is published under a **path prefix on the existing domain** — no
new DNS record or TLS cert needed:

```
https://gbp.zixify.zixai.in/backend/...   ->  http://127.0.0.1:3001/...
```

The trailing slash on `proxy_pass` strips the `/backend` prefix, so the backend
receives `/api/ingest/intel`, `/health`, etc. Example:

```
https://gbp.zixify.zixai.in/backend/health            -> 200 {"status":"ok",...}
https://gbp.zixify.zixai.in/backend/api/ingest/intel  -> 401 (needs zx_ key)
```

The existing SQLite sync server keeps serving `https://gbp.zixify.zixai.in/`
(`/health`, `/api/sync`, `/api/auth/*`) on `:3005` — untouched.

## IMPORTANT: which nginx is live

This VPS (`188.245.199.192`) runs **aaPanel / BT-Panel nginx**, not the distro
nginx:

- **Live:** `/www/server/nginx/sbin/nginx -c /www/server/nginx/conf/nginx.conf`
  - vhosts: `/www/server/panel/vhost/nginx/<domain>.conf`
  - each vhost `include`s `/www/server/panel/vhost/nginx/proxy/<domain>/*.conf`
- **Inactive/decoy:** the Ubuntu `/usr/sbin/nginx` + `/etc/nginx/...`
  (`nginx.service` is `failed`). **Do not edit `/etc/nginx` — it does nothing.**

## The routing snippet (already in place)

File: `/www/server/panel/vhost/nginx/proxy/gbp.zixify.zixai.in/backend-api.conf`

```nginx
location ^~ /backend/ {
    client_max_body_size 12m;
    proxy_pass         http://127.0.0.1:3001/;
    proxy_http_version 1.1;
    proxy_set_header   Host $host;
    proxy_set_header   X-Real-IP $remote_addr;
    proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header   X-Forwarded-Proto $scheme;
}
```

Apply / reload after edits (use the BT binary, validate first):

```bash
/www/server/nginx/sbin/nginx -t && /www/server/nginx/sbin/nginx -s reload
```

## Extension config

Point the extension's backend base URL at:

```
BACKEND_URL = https://gbp.zixify.zixai.in/backend
```

> Note: because the BT panel manages vhosts, if you later edit this domain's
> proxy settings **in the panel UI**, re-check that `backend-api.conf` survived.
> It lives in the panel's own `proxy/` include dir, so it normally persists.
