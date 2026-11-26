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
    signature: "Подпись: 5 быстрых миганий при включении", sig_on: "с подписью", blink: "Мигать светодиодом – раз в 2 с", blink_fast: "Мигать быстро – раз в 0,5 с",
    text: "Сообщение в debug-консоль (Serial.println)", send: "Собрать прошивку", job: "Задание на сборку", status: "Статус",
    checked: "Последняя проверка", next: "следующая через", download: "Скачать прошивку (zip)", check: "Проверить сейчас",
    new: "Новое задание", howto: "Как прошить (командная строка)",
    howto_intro: "Распакуйте архив, подключите Arduino по USB и выполните команды в распакованной папке (порт замените на свой). Тот же текст есть в FLASH.txt внутри архива.",
    howto_note: "Если avrdude пишет «not in sync»: закройте Arduino IDE и монитор порта; для старых клонов используйте -b 57600. При открытии порта плата перезагружается: сообщение появится сразу, потом каждые 10 миганий.",
    pub_h: "Опубликовать на устройство (автообновление)", pub_go: "Опубликовать",
    pub_help: "Как это работает: агент для Windows, macOS, Ubuntu, Raspberry Pi", auto: "Прошивать автоматически при новой версии →",
    pub_ok: "Опубликована версия {v} на {d}. Агент прошьёт её в течение 1–2 минут.", pub_need: "Нужны ID устройства и токен (создать: /help)",
    queued: "в очереди", building: "собирается", done: "готово", failed: "ошибка", error: "Ошибка: ",
  };
  var EN = { pub_ok: "Version {v} published to {d}. The agent flashes it within 1–2 minutes.", pub_need: "Device ID and token needed (create one: /help)", sig_on: "with signature", queued: "queued", building: "building", done: "done", failed: "failed", error: "Error: " };
  var T = /^(ru|uk)/i.test(navigator.language || "") ? RU : EN;
  if (T === RU) {
    document.documentElement.lang = "ru";
    document.querySelectorAll("[data-t]").forEach(function (e) { var k = e.getAttribute("data-t"); if (RU[k]) e.textContent = RU[k]; });
    document.querySelectorAll("option:disabled").forEach(function (o) { o.textContent = o.textContent.replace("(soon)", "(скоро)"); });
  }

  var $ = function (id) { return document.getElementById(id); };
  var ru = T === RU;
  var range = function (a, b) { var r = []; for (var i = a; i <= b; i++) r.push(i); return r; };
  var NODEMCU = { 16: "D0", 5: "D1", 4: "D2", 2: "D4", 14: "D5", 12: "D6", 13: "D7" };
  var PIHDR = { 2: 3, 3: 5, 4: 7, 17: 11, 27: 13, 22: 15, 10: 19, 9: 21, 11: 23, 5: 29, 6: 31, 13: 33, 19: 35, 26: 37, 14: 8, 15: 10,
                18: 12, 23: 16, 24: 18, 25: 22, 8: 24, 7: 26, 12: 32, 16: 36, 20: 38, 21: 40 };
  var ext = ru ? "Другие пины: светодиод + резистор 220–330 Ом на GND." : "Other pins: LED + 220–330 Ω resistor to GND.";
  var AVR = {
    kind: "avr", pins: range(2, 19), def: 13, agent: true,
    label: function (p) { return p === 13 ? (ru ? "13 – светодиод на плате (LED_BUILTIN)" : "13 – built-in LED (LED_BUILTIN)")
                                 : p >= 14 ? "A" + (p - 14) + " (" + p + ")" : p + ([3, 5, 6, 9, 10, 11].indexOf(p) >= 0 ? " (PWM)" : ""); },
    hint: ru ? "13 = светодиод на плате. " + ext + " 0/1 заняты Serial." : "13 = the LED on the board. " + ext + " 0/1 are taken by Serial.",
  };
  var BOARDS = {
    arduino_uno: AVR, arduino_nano: AVR,
    rpi_pico: { kind: "uf2", pins: range(0, 22).concat([25, 26, 27, 28]), def: 25,
      label: function (p) { return p === 25 ? (ru ? "GP25 – светодиод на плате" : "GP25 – on-board LED") : "GP" + p; },
      hint: (ru ? "GP25 = светодиод на Pico (у Pico W он на WiFi-чипе – выберите другой пин). " : "GP25 = the LED on the Pico (on a Pico W it sits on the WiFi chip – pick another pin). ") + ext },
    esp8266: { kind: "esp", pins: [2, 4, 5, 12, 13, 14, 16], def: 2,
      label: function (p) { return "GPIO" + p + " (" + NODEMCU[p] + ")" + (p === 2 ? (ru ? " – синий светодиод ESP-12" : " – blue LED of the ESP-12") : ""); },
      hint: (ru ? "GPIO2 = синий светодиод на модуле (горит при LOW). В скобках – надписи NodeMCU / D1 mini. " : "GPIO2 = blue LED on the module (lit when LOW). In brackets: NodeMCU / D1 mini labels. ") + ext },
    esp32_cam: { kind: "esp", pins: [33, 4, 2, 12, 13, 14, 15], def: 33,
      label: function (p) { return "GPIO" + p + (p === 33 ? (ru ? " – красный светодиод сзади" : " – red LED on the back") : p === 4 ? (ru ? " – белая вспышка (очень ярко!)" : " – white flash LED (very bright!)") : ""); },
      hint: (ru ? "GPIO33 = маленький красный светодиод (горит при LOW), GPIO4 = вспышка камеры. " : "GPIO33 = small red LED (lit when LOW), GPIO4 = camera flash. ") + ext },
    rpi_zero: { kind: "linux", pins: [99].concat(range(2, 27)), def: 99,
      label: function (p) { return p === 99 ? (ru ? "ACT – зелёный светодиод на плате" : "ACT – green on-board LED") : "GPIO" + p + (ru ? " (контакт " : " (pin ") + PIHDR[p] + ")"; },
      hint: ru ? "ACT = светодиод на плате. GPIO – нумерация BCM, в скобках номер контакта на гребёнке. Светодиод + резистор 220–330 Ом на GND."
               : "ACT = the on-board LED. GPIO = BCM numbering, in brackets the header pin. LED + 220–330 Ω resistor to GND." },
  };
  function board(id) { return BOARDS[id] || AVR; }
  function fillPins() {
    var b = board(f.elements.device.value), sel = f.elements.pin;
    sel.innerHTML = "";
    b.pins.forEach(function (p) { var o = document.createElement("option"); o.value = p; o.textContent = b.label(p); if (p === b.def) o.selected = true; sel.appendChild(o); });
    $("pin-hint").textContent = b.hint;
  }
  var f = $("f"), job = $("job"), timer = null, left = FAST, started = 0, blobUrl = null;
  var KEY = "bhf-job";

  fillPins();
  f.elements.device.addEventListener("change", fillPins);
  f.elements.text.addEventListener("input", function () { $("cnt").textContent = f.elements.text.value.length; });

  function store(id) { try { id ? localStorage.setItem(KEY, id) : localStorage.removeItem(KEY); } catch (e) {} }
  function stored() { try { return localStorage.getItem(KEY); } catch (e) { return null; } }
  function getJSON(r) { return r.json().catch(function () { return {}; }).then(function (d) { if (!r.ok) { var e = new Error(d.error || r.status); e.data = d; e.status = r.status; throw e; } return d; }); }

  function serialPS(port, dtr) {
    return "[Console]::OutputEncoding = [Text.Encoding]::UTF8\n$s = New-Object System.IO.Ports.SerialPort " + port + "," + BAUD +
      "; $s.Encoding = [Text.Encoding]::UTF8; $s.DtrEnable = " + (dtr ? "$true" : "$false") + "; $s.Open(); while ($true) { $s.ReadLine() }";
  }
  function howto(zipName, device) {
    var b = board(device), base = zipName.replace(/\.zip$/, ""), win, mac, lin, note = "";
    if (b.kind === "uf2") {
      var uf2 = base + ".uf2";
      win = "# BOOTSEL held while plugging in -> drive RPI-RP2 (or, if a bhf/Arduino firmware runs: 1200 baud reset)\n" +
        "$p = New-Object System.IO.Ports.SerialPort COM5,1200; $p.Open(); $p.Close()   # optional\n" +
        "Copy-Item " + uf2 + " ((Get-Volume -FileSystemLabel RPI-RP2).DriveLetter + \":\\\")\n# debug output\n" + serialPS("COM5", true);
      mac = "stty -f /dev/cu.usbmodem1101 1200     # optional, instead of BOOTSEL\ncp " + uf2 + " /Volumes/RPI-RP2/\nscreen -U /dev/cu.usbmodem1101 " + BAUD + "    # exit: Ctrl+A, K, Y";
      lin = "stty -F /dev/ttyACM0 1200             # optional, instead of BOOTSEL\ncp " + uf2 + " /media/$USER/RPI-RP2/\n" +
        "#  no desktop: sudo mount /dev/sda1 /mnt && sudo cp " + uf2 + " /mnt && sudo umount /mnt\nscreen -U /dev/ttyACM0 " + BAUD + "    # exit: Ctrl+A, K, Y";
      note = ru ? "Зажмите BOOTSEL и подключите Pico: появится диск RPI-RP2, скопируйте на него .uf2. Pico ждёт терминал до 3 с после старта." :
                  "Hold BOOTSEL while plugging the Pico in: a drive RPI-RP2 appears, copy the .uf2 onto it. The Pico waits up to 3 s for a terminal after start.";
    } else if (b.kind === "esp") {
      var bin = base + ".bin", c32 = device === "esp32_cam", chip = c32 ? "esp32" : "esp8266";
      var args = c32 ? "-z 0x1000 bootloader.bin 0x8000 partitions.bin 0xe000 boot_app0.bin 0x10000 " + bin : "0x0 " + bin;
      win = "py -m pip install esptool          # once (Python: winget install Python.Python.3.12)\n[System.IO.Ports.SerialPort]::GetPortNames()\n" +
        "py -m esptool --chip " + chip + " --port COM3 --baud 460800 write_flash " + args + "\n" +
        "py -m serial.tools.miniterm --raw --dtr 0 --rts 0 COM3 " + BAUD + "    # exit: Ctrl+]";
      mac = "python3 -m venv ~/esptool && ~/esptool/bin/pip install esptool    # once\nls /dev/cu.usbserial* /dev/cu.wchusbserial* /dev/cu.SLAB*\n" +
        "~/esptool/bin/python -m esptool --chip " + chip + " --port /dev/cu.usbserial-110 --baud 460800 write_flash " + args + "\n" +
        "~/esptool/bin/python -m serial.tools.miniterm --raw --dtr 0 --rts 0 /dev/cu.usbserial-110 " + BAUD;
      lin = "sudo apt install -y python3-venv && python3 -m venv ~/esptool && ~/esptool/bin/pip install esptool   # once\n" +
        "sudo usermod -aG dialout $USER       # once, then log out/in\n" +
        "~/esptool/bin/python -m esptool --chip " + chip + " --port /dev/ttyUSB0 --baud 460800 write_flash " + args + "\n" +
        "~/esptool/bin/python -m serial.tools.miniterm --raw --dtr 0 --rts 0 /dev/ttyUSB0 " + BAUD;
      note = c32 ? (ru ? "У ESP32-CAM нет USB: плата ESP32-CAM-MB или USB-UART 3,3 В (IO0 на GND + RST для прошивки, потом убрать перемычку и RST). Сообщение – после RST и каждые 10 миганий."
                       : "ESP32-CAM has no USB: use the ESP32-CAM-MB board or a 3.3 V USB-UART (IO0 to GND + RST to flash, then remove it and press RST). Message after RST and every 10 blinks.")
                 : (ru ? "NodeMCU / D1 mini прошиваются по USB сами; голый ESP-12 – через USB-UART 3,3 В, GPIO0 на GND при сбросе. Не получается – попробуйте --baud 115200."
                       : "NodeMCU / D1 mini flash over USB by themselves; a bare ESP-12 needs a 3.3 V USB-UART with GPIO0 to GND at reset. Fails? Try --baud 115200.");
    } else if (b.kind === "linux") {
      var cmd = "scp -r bhf pi@raspberrypi.local:\nssh pi@raspberrypi.local \"cd bhf && sudo sh install.sh\"\nssh pi@raspberrypi.local journalctl -u bhf-blink -f";
      win = "Expand-Archive " + zipName + " bhf\n" + cmd;
      mac = "unzip " + zipName + " -d bhf\n" + cmd;
      lin = "# on the Pi itself:\nunzip " + zipName + " -d bhf && cd bhf && sudo sh install.sh\njournalctl -u bhf-blink -f\n# remove: sudo sh install.sh remove";
      note = ru ? "Для Raspberry Pi «прошивка» – это программа на Python и служба systemd (стартует при загрузке). Нужен Raspberry Pi OS с ssh; имя пользователя и хоста – как в Raspberry Pi Imager."
                : "For a Raspberry Pi the \"firmware\" is a Python program + systemd service (starts at boot). Needs Raspberry Pi OS with ssh; user / host name as set in Raspberry Pi Imager.";
    } else {
      var hex = base + ".hex", flash = function (port) { return "-c arduino -p m328p -P " + port + " -b 115200 -U flash:w:" + hex + ":i"; };
      win = "# avrdude (once)\n" +
        "Invoke-WebRequest https://github.com/avrdudes/avrdude/releases/download/v8.3/avrdude-v8.3-windows-x64.zip -OutFile avrdude.zip\n" +
        "Expand-Archive avrdude.zip -DestinationPath avrdude\n# port\n[System.IO.Ports.SerialPort]::GetPortNames()\n" +
        "# flash\n.\\avrdude\\avrdude.exe " + flash("COM3") + "\n# debug output (Ctrl+C), UTF-8\n" + serialPS("COM3", true) + "\n" +
        "# no admin rights needed; CH340 clones: driver install needs admin";
      mac = "# no sudo needed\nbrew install avrdude\nls /dev/cu.usbmodem* /dev/cu.usbserial*\navrdude " + flash("/dev/cu.usbmodem1101") + "\n" +
        "screen -U /dev/cu.usbmodem1101 " + BAUD + "    # exit: Ctrl+A, K, Y";
      lin = "sudo apt install -y avrdude screen   # needs sudo\nsudo usermod -aG dialout $USER      # once: ports without sudo, then log out/in\n" +
        "ls /dev/ttyACM* /dev/ttyUSB*\navrdude " + flash(device === "arduino_nano" ? "/dev/ttyUSB0" : "/dev/ttyACM0") + "\n" +
        "#  \"Permission denied\" = not in dialout yet: log out/in or put sudo in front\nscreen -U /dev/ttyACM0 " + BAUD + "    # exit: Ctrl+A, K, Y";
    }
    $("h-win").textContent = win; $("h-mac").textContent = mac; $("h-lin").textContent = lin;
    $("h-board").textContent = note; $("h-board").hidden = !note; $("h-note").hidden = b.kind !== "avr";
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
      howto(j.artifact.filename, j.device);
      $("pub").hidden = !!blobUrl || !board(j.device).agent;   // agent: AVR boards only; direct builds are not stored
      var dv = device(); if (dv && !$("p-id").value) { $("p-id").value = dv.id; $("p-token").value = dv.token; }
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
          show({ id: j.id, device: j.device, device_name: j.device_name, firmware: j.firmware, firmware_name: j.firmware_name, pin: j.pin, signature: j.signature,
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

  // publish to a device for the auto-update agent (see /help); ID + token shared with /help via localStorage
  function device() { try { return JSON.parse(localStorage.getItem("bhf-dev") || "null"); } catch (e) { return null; } }
  $("p-go").addEventListener("click", function () {
    var id = $("p-id").value.trim(), token = $("p-token").value.trim(), jid = $("j-id").textContent;
    if (!id || !token) { $("p-msg").textContent = T.pub_need; return; }
    $("p-go").disabled = true; $("p-msg").textContent = "…";
    fetch("/api/devices/" + encodeURIComponent(id) + "/publish", { method: "POST", cache: "no-store",
          headers: { "content-type": "application/json", authorization: "Bearer " + token }, body: JSON.stringify({ job: jid }) })
      .then(getJSON)
      .then(function (d) {
        try { localStorage.setItem("bhf-dev", JSON.stringify({ id: id, token: token })); } catch (e) {}
        $("p-msg").textContent = T.pub_ok.replace("{v}", d.version).replace("{d}", d.name || d.id);
      })
      .catch(function (e) { $("p-msg").textContent = T.error + e.message; })
      .then(function () { $("p-go").disabled = false; });
  });

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
    job.hidden = true; $("howto").hidden = true; $("pub").hidden = true; $("p-msg").textContent = ""; f.hidden = false;
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
