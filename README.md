# bhf

Site **bhf.pp.ua** – Cloudflare Pages project `bhf`. Static files in `site/`, API in `functions/` (Pages Functions).
Deploy: push to `main` → GitHub Action (`.github/workflows/deploy.yml`, needs repo secrets `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`).

## Firmware builder (test)

`site/index.html` + `site/app.js`: choose device (Alexa, TV, Arduino Uno, ESP32, PC x86/64), firmware (blink, blink fast) and a text →
`POST /api/jobs` → job in KV (`JOBS_KV`, key `job:<id>`, TTL 7 days, status `queued`). The page polls every 120 s and offers
the download as soon as the builder has uploaded the result (R2 bucket `bhf-firmware`, binding `FW_R2`, key `fw/<id>/<file>`).

### Public API

| Method | Path | |
|---|---|---|
| POST | `/api/jobs` | `{"device":"esp32","firmware":"blink","text":"…"}` → job (`id`, `status`) |
| GET | `/api/jobs/<id>` | status: `queued` → `building` → `done` / `failed` |
| GET | `/api/jobs/<id>/download` | firmware file (409 until `done`) |

### Builder API (header `Authorization: Bearer $BUILDER_TOKEN`, Pages secret `BUILDER_TOKEN`)

```bash
B=https://bhf.pp.ua; H="Authorization: Bearer $BUILDER_TOKEN"
curl -s -H "$H" "$B/api/builder/jobs?status=queued"                                   # jobs incl. text, oldest first
curl -s -H "$H" -X POST "$B/api/builder/jobs/<id>/status" -H 'content-type: application/json' -d '{"status":"building"}'
curl -s -H "$H" -X PUT --data-binary @build/firmware.bin "$B/api/builder/jobs/<id>/artifact?filename=esp32-blink.bin"   # -> done
curl -s -H "$H" -X POST "$B/api/builder/jobs/<id>/status" -H 'content-type: application/json' -d '{"status":"failed","message":"compile error"}'
```
Devices: `alexa`, `tv`, `arduino_uno`, `esp32`, `pc_x86_64`. Firmware: `blink`, `blink_fast`. Text ≤ 4000 characters, artifact ≤ 50 MB.
