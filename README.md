# bhf

Site **bhf.pp.ua** – Cloudflare Pages project `bhf`. Static files in `site/`, API in `functions/` (Pages Functions).
Deploy: push to `main` → GitHub Action (`.github/workflows/deploy.yml`, needs repo secrets `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`).

## Firmware builder

Builder = Vercel function `https://odesa2027.vercel.app/api/build` (repo DmitryPodyachev/vercel.com, `api/build.py`).
Boards: Arduino Uno, Arduino Nano (avr-gcc + ArduinoCore-avr per job), Raspberry Pi Pico (.uf2), ESP8266 ESP-12E/F, ESP32-CAM
(template firmware with a patched config block), Raspberry Pi Zero (Python + systemd); pin lists per board in `PINS`
(functions) = `DEVICES` (api/build.py) = `BOARDS` (site/app.js), `GET /api/boards`. Auto-update agent: Uno / Nano only.
 `blink` = LED toggles every 2 s, `blink_fast` = every 0.5 s,
the text is printed to Serial (115200 baud). Result: zip with `.hex`, `FLASH.txt` (avrdude for Windows/macOS/Ubuntu), sketch.
The page creates the job, then calls the builder with `{"id"}` → builder reads the job (`GET /api/builder/jobs/<id>`),
builds, uploads the zip to R2. If the Vercel env `BHF_BUILDER_TOKEN` is not set, the builder answers 503 `no_token`
and the page falls back to a direct build (zip straight to the browser, job stays `queued`).
Builder token: Pages secret `BUILDER_TOKEN` (or `VERCEL_BUILDER_TOKEN`, optional second one).
Assets in `index.html` use content-hash `?v=` – never request a new `?v` before the deploy is live (edge caches 4 h).


`site/index.html` + `site/app.js`: choose device (Alexa, TV, Arduino Uno, ESP32, PC x86/64), firmware (blink, blink fast) and a text →
`POST /api/jobs` → job in KV (`JOBS_KV`, key `job:<id>`, TTL 7 days, status `queued`). The page polls every 120 s and offers
the download as soon as the builder has uploaded the result (R2 bucket `bhf-firmware`, binding `FW_R2`, key `fw/<id>/<file>`).

### Auto-update (devices + agent)

Page `/help/` (`site/help/index.html`, `site/help.js`): create a device (ID + token, token shown once, KV stores its sha256),
install the agent `site/bhf-agent.py` (served as `https://bhf.pp.ua/bhf-agent.py`, Python stdlib + avrdude) on the computer the
board is plugged into (Windows / macOS / Ubuntu / Raspberry Pi), publish a finished build to the device on the main page.
The agent polls `GET /api/devices/<id>` every 60 s, flashes when `current.sha256` changes, checks the Serial line
`bhf <fw> job <id>` and reports back. Published zips are copied to R2 `dev/<id>/` (outside the 7-day `fw/` lifecycle rule).

| Method | Path (header `Authorization: Bearer <device token>`) | |
|---|---|---|
| POST | `/api/devices` (no auth) | `{"name":"…"}` → `{id, token}` |
| GET | `/api/devices/<id>` | current version + last agent report |
| POST | `/api/devices/<id>/publish` | `{"job":"<id>"}` → version + 1 |
| GET | `/api/devices/<id>/firmware` | zip of the current version |
| POST | `/api/devices/<id>/report` | agent report |
| DELETE | `/api/devices/<id>` | device + its files |

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
