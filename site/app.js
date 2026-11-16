// bhf firmware builder – test page: create a job, poll every 120 s, offer the download when the builder is done.
(function () {
  "use strict";
  var POLL = 120;                                     // seconds
  var RU = {
    h1: "Сборка прошивки", intro: "Тестовая страница: выберите устройство и прошивку, добавьте текст. Сборка идёт на отдельном сборщике, страница проверяет статус каждые 2 минуты и предложит скачать результат, когда он будет готов.",
    device: "Устройство", firmware: "Прошивка", blink: "Мигать лампочкой", blink_fast: "Мигать быстро", text: "Текст",
    send: "Отправить", job: "Задание на сборку", status: "Статус", checked: "Последняя проверка", next: "следующая через",
    download: "Скачать прошивку", check: "Проверить сейчас", new: "Новое задание",
    queued: "в очереди", building: "собирается", done: "готово", failed: "ошибка", error: "Ошибка: ",
  };
  var EN = { queued: "queued", building: "building", done: "done", failed: "failed", error: "Error: " };
  var T = /^(ru|uk)/i.test(navigator.language || "") ? RU : EN;
  if (T === RU) {
    document.documentElement.lang = "ru";
    document.querySelectorAll("[data-t]").forEach(function (e) { var k = e.getAttribute("data-t"); if (RU[k]) e.textContent = RU[k]; });
  }

  var $ = function (id) { return document.getElementById(id); };
  var f = $("f"), job = $("job"), timer = null, left = POLL;
  var KEY = "bhf-job";

  f.elements.text.addEventListener("input", function () { $("cnt").textContent = f.elements.text.value.length; });

  function store(id) { try { id ? localStorage.setItem(KEY, id) : localStorage.removeItem(KEY); } catch (e) {} }
  function stored() { try { return localStorage.getItem(KEY); } catch (e) { return null; } }

  function show(j) {
    f.hidden = true; job.hidden = false;
    $("j-id").textContent = j.id;
    $("j-dev").textContent = j.device_name;
    $("j-fw").textContent = T[j.firmware] || j.firmware_name;
    $("j-status").textContent = T[j.status] || j.status;
    $("j-status").className = "st-" + j.status;
    $("j-msg").textContent = j.message || "";
    $("j-checked").textContent = new Date().toLocaleTimeString();
    var ready = j.status === "done" && j.artifact;
    $("j-ready").hidden = !ready;
    if (ready) {
      $("j-dl").href = "/api/jobs/" + encodeURIComponent(j.id) + "/download";
      $("j-size").textContent = j.artifact.filename + " · " + (j.artifact.size / 1024).toFixed(1) + " KB";
      stop();
      $("j-next").textContent = "—";
    }
    if (j.status === "failed") { stop(); $("j-next").textContent = "—"; }
  }

  function check(id) {
    return fetch("/api/jobs/" + encodeURIComponent(id), { cache: "no-store" })
      .then(function (r) { return r.json().then(function (d) { if (!r.ok) throw new Error(d.error || r.status); return d; }); })
      .then(show)
      .catch(function (e) { $("j-msg").textContent = T.error + e.message; });
  }

  function stop() { if (timer) clearInterval(timer); timer = null; }
  function start(id) {
    stop(); left = POLL;
    timer = setInterval(function () {
      left -= 1;
      $("j-next").textContent = left + " s";
      if (left <= 0) { left = POLL; check(id); }
    }, 1000);
    $("j-next").textContent = left + " s";
  }

  f.addEventListener("submit", function (e) {
    e.preventDefault();
    var fw = f.querySelector("input[name=firmware]:checked");
    var body = { device: f.elements.device.value, firmware: fw ? fw.value : "", text: f.elements.text.value };
    $("send").disabled = true;
    fetch("/api/jobs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().then(function (d) { if (!r.ok) throw new Error(d.error || r.status); return d; }); })
      .then(function (j) { store(j.id); location.hash = j.id; show(j); start(j.id); })
      .catch(function (err) { alert(T.error + err.message); })
      .then(function () { $("send").disabled = false; });
  });

  $("check").addEventListener("click", function () { var id = $("j-id").textContent; if (id) { check(id); if (timer) start(id); } });
  $("new").addEventListener("click", function () { stop(); store(null); history.replaceState(null, "", location.pathname); job.hidden = true; f.hidden = false; });

  // resume a job after reload (hash or localStorage)
  var id = (location.hash || "").slice(1) || stored();
  if (id && /^[a-z0-9]{8,40}$/.test(id)) {
    check(id).then(function () { if ($("j-ready").hidden && $("j-status").className !== "st-failed") start(id); });
  }
})();
