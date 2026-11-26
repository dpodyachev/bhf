// bhf.pp.ua – firmware build jobs.
// Public:  POST /api/jobs                      {device, firmware, text, pin?, signature?}  -> {id}
//          GET  /api/jobs/<id>                 -> job status (no text echo beyond what was sent)
//          GET  /api/jobs/<id>/download        -> firmware file from R2 (when status = done)
// Builder (header "Authorization: Bearer <BUILDER_TOKEN or VERCEL_BUILDER_TOKEN>"):
//          GET  /api/builder/jobs?status=queued        -> list of jobs (oldest first)
//          GET  /api/builder/jobs/<id>                 -> one job incl. text
//          POST /api/builder/jobs/<id>/status  {status: building|failed, message?}
//          PUT  /api/builder/jobs/<id>/artifact?filename=fw.bin   (body = file)  -> status done
// Devices (auto-update agent, header "Authorization: Bearer <device token>"):
//          POST /api/devices                   {name?, board?}   -> {id, token} (token shown once, only its sha256 is stored)
//          GET  /api/devices/<id>              -> current version {version, job, sha256, url} + last report
//          POST /api/devices/<id>/publish      {job}             -> copies the job's zip to R2 dev/<id>/, version + 1
//          GET  /api/devices/<id>/firmware     -> zip of the current version
//          POST /api/devices/<id>/report       {version, job, ok, verified, message, serial}
//          DELETE /api/devices/<id>
// Storage: KV JOBS_KV "dev:<id>" (no TTL); R2 "dev/<id>/<version>-<file>" (only the latest kept).
// Storage: KV JOBS_KV  "job:<id>" (JSON, TTL 7 days); R2 FW_R2 "fw/<id>/<filename>".

const DEVICES = { alexa: "Amazon Alexa", tv: "TV", arduino_uno: "Arduino Uno", arduino_nano: "Arduino Nano",
                  rpi_pico: "Raspberry Pi Pico", rpi_zero: "Raspberry Pi Zero / Zero 2 W", esp8266: "ESP8266 (ESP-12E/F)",
                  esp32_cam: "ESP32-CAM (AI Thinker)", esp32: "ESP32", pc_x86_64: "PC x86/64" };
const FIRMWARES = { blink: "Blink LED", blink_fast: "Blink LED fast" };
const TTL = 7 * 24 * 3600;
const MAX_TEXT = 4000;
const MAX_ARTIFACT = 50 * 1024 * 1024;
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const PINS = {                                                       // allowed LED pins, default = on-board LED (same as api/build.py)
  arduino_uno: { list: range(2, 19), def: 13 },                      // 0/1 = Serial RX/TX; 14-19 = A0-A5
  arduino_nano: { list: range(2, 19), def: 13 },
  rpi_pico: { list: [...range(0, 22), 25, 26, 27, 28], def: 25 },
  esp8266: { list: [2, 4, 5, 12, 13, 14, 16], def: 2 },
  esp32_cam: { list: [33, 4, 2, 12, 13, 14, 15], def: 33 },
  rpi_zero: { list: [99, ...range(2, 27)], def: 99 },                // 99 = on-board ACT LED
};
const AGENT_BOARDS = ["arduino_uno", "arduino_nano"];                // boards the auto-update agent can flash (avrdude)

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

function newId() {
  const t = (8640000000000000 - Date.now()).toString(36);          // newest first in KV list
  const r = crypto.getRandomValues(new Uint8Array(6));
  return t + Array.from(r, (b) => b.toString(16).padStart(2, "0")).join("");
}

function same(a, b) {                                                // constant-time compare
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let x = 0;
  for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return x === 0;
}

function pub(job) {
  const { id, device, firmware, status, created, updated, message, artifact, pin, signature } = job;
  return { id, device, device_name: DEVICES[device], firmware, firmware_name: FIRMWARES[firmware], pin, signature: !!signature,
           status, created, updated,
           message: message || "", artifact: artifact ? { filename: artifact.filename, size: artifact.size } : null };
}

async function getJob(env, id) {
  if (!/^[a-z0-9]{8,40}$/.test(id)) return null;
  return env.JOBS_KV.get("job:" + id, "json");
}

// KV is eventually consistent (stale reads up to ~60 s after the builder finished) – R2 is not:
// if the artifact is already in R2, the job is done whatever KV still says.
async function withR2(env, job) {
  if (!job || job.status === "done" || job.status === "failed") return job;
  const r = await env.FW_R2.list({ prefix: `fw/${job.id}/`, limit: 1 });
  const o = r.objects && r.objects[0];
  if (o) {
    job.status = "done"; job.message = "";
    job.artifact = { key: o.key, filename: o.key.split("/").pop(), size: o.size };
  }
  return job;
}

async function putJob(env, job) {
  job.updated = new Date().toISOString();
  await env.JOBS_KV.put("job:" + job.id, JSON.stringify(job), {
    expirationTtl: TTL, metadata: { s: job.status, c: job.created },
  });
}

// ---------- devices ----------
const hex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, "0")).join("");
const b64url = (u8) => btoa(String.fromCharCode(...u8)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
async function sha256hex(data) {
  const buf = typeof data === "string" ? new TextEncoder().encode(data) : data;
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", buf)));
}
async function getDev(env, id) {
  if (!/^d[0-9a-f]{10}$/.test(id)) return null;
  return env.JOBS_KV.get("dev:" + id, "json");
}
async function putDev(env, dev) {                                     // no TTL: devices stay until deleted
  await env.JOBS_KV.put("dev:" + dev.id, JSON.stringify(dev));
}
function pubDev(dev) {
  const c = dev.current;
  return { id: dev.id, name: dev.name, board: dev.board, board_name: DEVICES[dev.board], created: dev.created, seen: dev.seen || null,
           version: dev.version || 0,
           current: c ? { version: c.version, job: c.job, filename: c.filename, size: c.size, sha256: c.sha256, firmware: c.firmware,
                          pin: c.pin, signature: c.signature, published: c.published, url: `/api/devices/${dev.id}/firmware` } : null,
           report: dev.report || null };
}

export async function onRequest(ctx) {
  const { request, env, params } = ctx;
  const parts = params.path || [];
  const m = request.method;
  try {
    // ---------- public ----------
    if (parts[0] === "jobs") {
      if (parts.length === 1 && m === "POST") {
        let b;
        try { b = await request.json(); } catch { return json({ error: "invalid JSON" }, 400); }
        const device = String(b.device || ""), firmware = String(b.firmware || ""), text = String(b.text || "");
        if (!DEVICES[device]) return json({ error: "unknown device" }, 400);
        if (!FIRMWARES[firmware]) return json({ error: "unknown firmware" }, 400);
        if (text.length > MAX_TEXT) return json({ error: `text longer than ${MAX_TEXT} characters` }, 400);
        const pr = PINS[device];
        if (!pr) return json({ error: "this board is not supported yet" }, 400);
        const pin = b.pin === undefined || b.pin === "" || b.pin === null ? pr.def : Number(b.pin);
        if (!pr.list.includes(pin)) return json({ error: `pin must be one of ${pr.list.join(", ")}` }, 400);
        const signature = b.signature === true || b.signature === "1" || b.signature === "on";
        const now = new Date().toISOString();
        const job = { id: newId(), device, firmware, text, pin, signature, status: "queued", created: now, updated: now,
                      ip_country: request.cf?.country || "" };
        await putJob(env, job);
        return json(pub(job), 201);
      }
      const job = await withR2(env, parts[1] ? await getJob(env, parts[1]) : null);
      if (!job) return json({ error: "job not found (jobs expire after 7 days)" }, 404);
      if (parts.length === 2 && m === "GET") return json(pub(job));
      if (parts.length === 3 && parts[2] === "download" && m === "GET") {
        if (job.status !== "done" || !job.artifact) return json({ error: "not ready" }, 409);
        const obj = await env.FW_R2.get(job.artifact.key);
        if (!obj) return json({ error: "file missing" }, 410);
        return new Response(obj.body, { headers: {
          "content-type": "application/octet-stream",
          "content-length": String(obj.size),
          "content-disposition": `attachment; filename="${job.artifact.filename.replace(/"/g, "")}"`,
          "cache-control": "no-store",
        } });
      }
      return json({ error: "not found" }, 404);
    }

    if (parts[0] === "boards" && m === "GET") return json({ boards: Object.keys(PINS).map((k) => ({ id: k, name: DEVICES[k], pins: PINS[k].list, def: PINS[k].def, agent: AGENT_BOARDS.includes(k) })) });

    // ---------- devices (auto-update agent) ----------
    if (parts[0] === "devices") {
      if (parts.length === 1 && m === "POST") {
        const b = await request.json().catch(() => ({}));
        const board = String(b.board || "arduino_uno");
        if (!AGENT_BOARDS.includes(board)) return json({ error: "auto-update supports " + AGENT_BOARDS.join(", ") + " for now" }, 400);
        const name = String(b.name || "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 40);
        const id = "d" + hex(crypto.getRandomValues(new Uint8Array(5)));
        const token = b64url(crypto.getRandomValues(new Uint8Array(24)));
        const dev = { id, name, board, token_sha: await sha256hex(token), created: new Date().toISOString(), version: 0, current: null, report: null };
        await putDev(env, dev);
        return json({ ...pubDev(dev), token }, 201);                 // the token is shown only here
      }
      const dev = await getDev(env, parts[1] || "");
      const auth = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
      if (!dev || !auth || !same(await sha256hex(auth), dev.token_sha)) return json({ error: "unknown device or wrong token" }, 401);
      if (parts.length === 2 && m === "GET") {
        const now = Date.now();
        if (new URL(request.url).searchParams.get("agent") && (!dev.seen || now - Date.parse(dev.seen) > 3600e3)) {
          dev.seen = new Date(now).toISOString();                    // at most one KV write per hour (free plan: 1000 writes/day)
          ctx.waitUntil(putDev(env, dev));
        }
        return json(pubDev(dev));
      }
      if (parts.length === 2 && m === "DELETE") {
        const l = await env.FW_R2.list({ prefix: `dev/${dev.id}/` });
        await Promise.all(l.objects.map((o) => env.FW_R2.delete(o.key)));
        await env.JOBS_KV.delete("dev:" + dev.id);
        return json({ deleted: dev.id });
      }
      if (parts[2] === "publish" && m === "POST") {
        const b = await request.json().catch(() => ({}));
        const job = await withR2(env, await getJob(env, String(b.job || "")));
        if (!job) return json({ error: "job not found (jobs expire after 7 days)" }, 404);
        if (job.status !== "done" || !job.artifact) return json({ error: "job is not built yet" }, 409);
        if (job.device !== dev.board) return json({ error: `job is for ${job.device}, device is ${dev.board}` }, 400);
        const obj = await env.FW_R2.get(job.artifact.key);
        if (!obj) return json({ error: "file missing" }, 410);
        const data = await obj.arrayBuffer();
        const version = (dev.version || 0) + 1;
        const key = `dev/${dev.id}/${version}-${job.artifact.filename}`;   // outside fw/ = not removed by the 7-day lifecycle rule
        await env.FW_R2.put(key, data, { httpMetadata: { contentType: "application/zip" } });
        const old = await env.FW_R2.list({ prefix: `dev/${dev.id}/` });
        await Promise.all(old.objects.filter((o) => o.key !== key).map((o) => env.FW_R2.delete(o.key)));
        dev.version = version;
        dev.current = { version, job: job.id, key, filename: job.artifact.filename, size: data.byteLength,
                        sha256: await sha256hex(data), firmware: job.firmware, pin: job.pin, signature: !!job.signature,
                        published: new Date().toISOString() };
        await putDev(env, dev);
        return json(pubDev(dev));
      }
      if (parts[2] === "firmware" && m === "GET") {
        const obj = dev.current && await env.FW_R2.get(dev.current.key);
        if (!obj) return json({ error: "nothing published" }, 404);
        return new Response(obj.body, { headers: {
          "content-type": "application/zip", "content-length": String(obj.size), "cache-control": "no-store",
          "content-disposition": `attachment; filename="${dev.current.filename.replace(/"/g, "")}"`,
        } });
      }
      if (parts[2] === "report" && m === "POST") {
        const b = await request.json().catch(() => ({}));
        dev.report = { at: new Date().toISOString(), version: Number(b.version) || 0, job: String(b.job || "").slice(0, 40),
                       ok: !!b.ok, verified: b.verified === true ? true : b.verified === false ? false : null,
                       message: String(b.message || "").slice(0, 500), serial: String(b.serial || "").slice(0, 1000),
                       host: String(b.host || "").slice(0, 60), os: String(b.os || "").slice(0, 60) };
        dev.seen = dev.report.at;
        await putDev(env, dev);
        return json(pubDev(dev));
      }
      return json({ error: "not found" }, 404);
    }

    // ---------- builder ----------
    if (parts[0] === "builder") {
      const auth = request.headers.get("authorization") || "";
      const ok = [env.BUILDER_TOKEN, env.VERCEL_BUILDER_TOKEN].some((t) => t && same(auth, "Bearer " + t));
      if (!ok) return json({ error: "unauthorized" }, 401);
      if (parts[1] === "jobs" && parts.length === 2 && m === "GET") {
        const want = new URL(request.url).searchParams.get("status") || "queued";
        const out = [];
        let cursor;
        do {
          const r = await env.JOBS_KV.list({ prefix: "job:", cursor });
          for (const k of r.keys) if (!want || want === "all" || k.metadata?.s === want) out.push(k.name.slice(4));
          cursor = r.list_complete ? null : r.cursor;
        } while (cursor && out.length < 200);
        const jobs = (await Promise.all(out.slice(0, 100).map((id) => getJob(env, id)))).filter(Boolean);
        jobs.sort((a, b) => a.created.localeCompare(b.created));                 // oldest first = build order
        return json({ jobs });                                                   // full jobs incl. text
      }
      const job = parts[2] ? await getJob(env, parts[2]) : null;
      if (parts[1] !== "jobs" || !job) return json({ error: "job not found" }, 404);
      if (parts.length === 3 && m === "GET") return json(job);                    // full job incl. text
      if (parts[3] === "status" && m === "POST") {
        const b = await request.json().catch(() => ({}));
        if (!["queued", "building", "failed"].includes(b.status)) return json({ error: "status must be queued|building|failed" }, 400);
        job.status = b.status;
        job.message = String(b.message || "").slice(0, 500);
        await putJob(env, job);
        return json(pub(job));
      }
      if (parts[3] === "artifact" && m === "PUT") {
        const fn = (new URL(request.url).searchParams.get("filename") || "firmware.bin").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);
        const len = Number(request.headers.get("content-length") || 0);
        if (len > MAX_ARTIFACT) return json({ error: "artifact too large" }, 413);
        const key = `fw/${job.id}/${fn}`;
        const body = len > 0 ? request.body : await request.arrayBuffer();     // R2 needs a known length
        const put = await env.FW_R2.put(key, body, { httpMetadata: { contentType: "application/octet-stream" } });
        job.artifact = { key, filename: fn, size: put.size };
        job.status = "done";
        job.message = "";
        await putJob(env, job);
        return json(pub(job));
      }
      return json({ error: "not found" }, 404);
    }
    return json({ error: "not found" }, 404);
  } catch (e) {
    return json({ error: "server error", detail: String(e && e.message || e).slice(0, 200) }, 500);
  }
}
