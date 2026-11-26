// bhf firmware builder – create a job, ask the builder (Vercel) to build it, poll the status, offer the download.
(function () {
  "use strict";
  var BUILDER = "https://odesa2027.vercel.app/api/build";
  var FAST = 5, SLOW = 120, FAST_FOR = 180;           // poll every 5 s for the first 3 min, then every 2 min
  var BAUD = 115200;
  var RU = {
    h1: "Сборка прошивки",
    intro: "Выберите плату и прошивку, добавьте сообщение для debug-консоли. Прошивка компилируется на сервере (avr-gcc) за несколько секунд. Вы получите zip с .hex-файлом, исходником и инструкцией, как прошить.",
    device: "Плата", firmware: "Прошивка", pin: "Пин светодиода",
    pin_hint: "13 = светодиод на плате. Другие пины: светодиод + резистор 220–330 Ом на GND. 0/1 заняты Serial.",
    signature: "Подпись: 5 быстрых миганий при включении", sig_on: "с подписью", blink: "Мигать светодиодом – раз в 2 с", blink_fast: "Мигать быстро – раз в 0,5 с",
    text: "Сообщение в debug-консоль (Serial.println)", send: "Собрать прошивку", job: "Задание на сборку", status: "Статус",
    checked: "Последняя проверка", next: "следующая через", download: "Скачать прошивку (zip)", check: "Проверить сейчас",
    new: "Новое задание", howto: "Как прошить (командная строка)",
    howto_intro: "Распакуйте архив, подключите Arduino по USB и выполните команды в распакованной папке (порт замените на свой). Тот же текст есть в FLASH.txt внутри архива.",
    howto_note: "Если avrdude пишет «not in sync»: закройте Arduino IDE и монитор порта; для старых клонов используйте -b 57600. При открытии порта плата перезагружается: сообщение появится сразу, потом каждые 10 миганий.",
    queued: "в очереди", building: "собирается", done: "готово", failed: "ошибка", error: "Ошибка: ",
  };
  var EN = { sig_on: "with signature", queued: "queued", building: "building", done: "done", failed: "failed", error: "Error: " };
  var T = /^(ru|uk)/i.test(navigator.language || "") ? RU : EN;
  if (T === RU) {
    document.documentElement.lang = "ru";
    document.querySelectorAll("[data-t]").forEach(function (e) { var k = e.getAttribute("data-t"); if (RU[k]) e.textContent = RU[k]; });
    document.querySelectorAll("option:disabled").forEach(function (o) { o.textContent = o.textContent.replace("(soon)", "(скоро)"); });
    var o13 = document.querySelector("select[name=pin] option[value='13']"); if (o13) o13.textContent = "13 – светодиод на плате (LED_BUILTIN)";
  }

  var $ = function (id) { return document.getElementById(id); };
  var f = $("f"), job = $("job"), timer = null, left = FAST, started = 0, blobUrl = null;
  var KEY = "bhf-job";

  f.elements.text.addEventListener("input", function () { $("cnt").textContent = f.elements.text.value.length; });

  function store(id) { try { id ? localStorage.setItem(KEY, id) : localStorage.removeItem(KEY); } catch (e) {} }
  function stored() { try { return localStorage.getItem(KEY); } catch (e) { return null; } }
  function getJSON(r) { return r.json().catch(function () { return {}; }).then(function (d) { if (!r.ok) { var e = new Error(d.error || r.status); e.data = d; e.status = r.status; throw e; } return d; }); }

  function howto(zipName) {
    var hex = zipName.replace(/\.zip$/, ".hex"), part = "m328p";
    var flash = function (port) { return "-c arduino -p " + part + " -P " + port + " -b 115200 -U flash:w:" + hex + ":i"; };
    $("h-win").textContent =
      "# avrdude (once)\n" +
      "Invoke-WebRequest https://github.com/avrdudes/avrdude/releases/download/v8.3/avrdude-v8.3-windows-x64.zip -OutFile avrdude.zip\n" +
      "Expand-Archive avrdude.zip -DestinationPath avrdude\n" +
      "# port\n[System.IO.Ports.SerialPort]::GetPortNames()\n" +
      "# flash\n.\\avrdude\\avrdude.exe " + flash("COM3") + "\n" +
      "# debug output (Ctrl+C), UTF-8\n[Console]::OutputEncoding = [Text.Encoding]::UTF8\n" +
      "$s = New-Object System.IO.Ports.SerialPort COM3," + BAUD + "; $s.Encoding = [Text.Encoding]::UTF8; $s.DtrEnable = $true; $s.Open(); while ($true) { $s.ReadLine() }\n" +
      "# no admin rights needed; CH340 clones: driver install needs admin";
    $("h-mac").textContent =
      "# no sudo needed\nbrew install avrdude\nls /dev/cu.usbmodem* /dev/cu.usbserial*\n" +
      "avrdude " + flash("/dev/cu.usbmodem1101") + "\n" +
      "screen -U /dev/cu.usbmodem1101 " + BAUD + "    # exit: Ctrl+A, K, Y";
    $("h-lin").textContent =
      "sudo apt install -y avrdude screen   # needs sudo\nsudo usermod -aG dialout $USER      # once: ports without sudo, then log out/in\n" +
      "ls /dev/ttyACM* /dev/ttyUSB*\n" +
      "avrdude " + flash("/dev/ttyACM0") + "\n" +
      "#  \"Permission denied\" = not in dialout yet: log out/in or put sudo in front\n" +
      "screen -U /dev/ttyACM0 " + BAUD + "    # exit: Ctrl+A, K, Y";
    $("howto").hidden = false;
  }

  function show(j) {
    f.hidden = true; job.hidden = false;
    $("j-id").textContent = j.id;
    $("j-dev").textContent = j.device_name;
    $("j-fw").textContent = T[j.firmware] || j.firmware_name;
    $("j-pin").textContent = (j.pin != null ? j.pin : 13) + (j.signature ? " · " + (T.sig_on || "with signature") : "");
    $("j-status").textContent = T[j.status] || j.status;
    $("j-status").className = "st-" + j.status;
    $("j-msg").textContent = j.message && j.message !== "vercel" ? j.message : "";
    $("j-checked").textContent = new Date().toLocaleTimeString();
    var ready = j.status === "done" && j.artifact;
    $("j-ready").hidden = !ready;
    if (ready) {
      $("j-dl").href = blobUrl || "/api/jobs/" + encodeURIComponent(j.id) + "/download";
      if (blobUrl) $("j-dl").setAttribute("download", j.artifact.filename);
      $("j-size").textContent = j.artifact.filename + " · " + (j.artifact.size / 1024).toFixed(1) + " KB";
      howto(j.artifact.filename);
      stop(); $("j-next").textContent = "—";
    }
    if (j.status === "failed") { stop(); $("j-next").textContent = "—"; }
    return j;
  }

  function check(id) {
    return fetch("/api/jobs/" + encodeURIComponent(id), { cache: "no-store" }).then(getJSON).then(show)
      .catch(function (e) { $("j-msg").textContent = T.error + e.message; });
  }

  // direct build (fallback while the builder has no token for the job queue): zip comes straight back
  function direct(j, body) {
    return fetch(BUILDER, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
      .then(function (r) {
        if (!r.ok) return getJSON(r);
        var name = ((r.headers.get("content-disposition") || "").match(/filename="([^"]+)"/) || [])[1] || "firmware.zip";
        return r.blob().then(function (b) {
          blobUrl = URL.createObjectURL(b);
          show({ id: j.id, device_name: j.device_name, firmware: j.firmware, firmware_name: j.firmware_name, pin: j.pin, signature: j.signature,
                 status: "done", artifact: { filename: name, size: b.size } });
        });
      });
  }

  function build(j, body) {
    $("j-status").textContent = T.building; $("j-status").className = "st-building";
    return fetch(BUILDER, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: j.id }) })
      .then(getJSON).then(function (r) { if (r && r.id) show(r); })
      .catch(function (e) {
        if (e.data && e.data.code === "no_token" && body) return direct(j, body);
        if (e.status !== 409) $("j-msg").textContent = T.error + e.message;
      });
  }

  function stop() { if (timer) clearInterval(timer); timer = null; }
  function start(id) {
    stop(); started = Date.now(); left = FAST;
    timer = setInterval(function () {
      left -= 1;
      $("j-next").textContent = left + " s";
      if (left <= 0) { left = (Date.now() - started) / 1000 < FAST_FOR ? FAST : SLOW; check(id); }
    }, 1000);
    $("j-next").textContent = left + " s";
  }

  f.addEventListener("submit", function (e) {
    e.preventDefault();
    var fw = f.querySelector("input[name=firmware]:checked");
    var body = { device: f.elements.device.value, firmware: fw ? fw.value : "", text: f.elements.text.value,
                 pin: Number(f.elements.pin.value), signature: f.elements.signature.checked };
    $("send").disabled = true;
    fetch("/api/jobs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
      .then(getJSON)
      .then(function (j) { store(j.id); location.hash = j.id; show(j); start(j.id); return build(j, body); })
      .catch(function (err) { alert(T.error + err.message); })
      .then(function () { $("send").disabled = false; });
  });

  $("check").addEventListener("click", function () {
    var id = $("j-id").textContent; if (!id) return;
    check(id).then(function (j) { if (j && j.status === "queued") build(j, null); });
    if (timer) start(id);
  });
  $("new").addEventListener("click", function () {
    stop(); store(null); history.replaceState(null, "", location.pathname);
    job.hidden = true; $("howto").hidden = true; f.hidden = false;
    if (blobUrl) { URL.revokeObjectURL(blobUrl); blobUrl = null; $("j-dl").removeAttribute("download"); }
  });

  // resume a job after reload (hash or localStorage); a job left in the queue is sent to the builder again
  var id = (location.hash || "").slice(1) || stored();
  if (id && /^[a-z0-9]{8,40}$/.test(id)) {
    check(id).then(function (j) {
      if (!j || j.status === "done" || j.status === "failed") return;
      start(id);
      if (j.status === "queued") build(j, null);
    });
  }
})();
