// bhf /help – create or pick a device (ID + token in localStorage), show its status, fill the commands.
(function () {
  "use strict";
  var KEY = "bhf-dev";
  var $ = function (id) { return document.getElementById(id); };
  var cmds = Array.prototype.slice.call(document.querySelectorAll("pre.cmd"));
  cmds.forEach(function (p) { p.setAttribute("data-tpl", p.textContent); });

  function get() { try { return JSON.parse(localStorage.getItem(KEY) || "null"); } catch (e) { return null; } }
  function put(d) { try { d ? localStorage.setItem(KEY, JSON.stringify(d)) : localStorage.removeItem(KEY); } catch (e) {} }
  function api(method, path, token, body) {
    var h = { "content-type": "application/json" };
    if (token) h.authorization = "Bearer " + token;
    return fetch(path, { method: method, headers: h, cache: "no-store", body: body ? JSON.stringify(body) : undefined })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { if (!r.ok) throw new Error(d.error || r.status); return d; }); });
  }
  function when(s) { return s ? new Date(s).toLocaleString() : "—"; }

  function fill(d) {
    cmds.forEach(function (p) {
      var t = p.getAttribute("data-tpl");
      p.textContent = d ? t.split("DEVICE_ID").join(d.id).split("TOKEN").join(d.token) : t;
    });
  }

  function render(info, d, fresh) {
    $("dev-none").hidden = true; $("dev-box").hidden = false;
    $("dev-token-note").hidden = !fresh;
    $("d-id").textContent = info.id;
    $("d-token").textContent = fresh ? d.token : "••••••••";
    $("d-show").hidden = !!fresh;
    $("d-name").textContent = (info.name || "—") + " · " + (info.board_name || info.board);
    var c = info.current;
    $("d-cur").textContent = c
      ? "версия " + c.version + " · " + c.firmware + ", пин " + c.pin + (c.signature ? ", подпись" : "") + " · job " + c.job + " · " + when(c.published)
      : "ничего (опубликуйте сборку на главной)";
    var r = info.report, t;
    if (!r) t = info.seen ? "на связи " + when(info.seen) + ", ещё ничего не прошивал" : "ещё не подключался";
    else {
      t = (r.ok ? "✔ прошита версия " + r.version : "✘ ошибка прошивки версии " + r.version) +
          (r.ok && r.verified === true ? " (подтверждено по Serial)" : r.ok && r.verified === false ? " (Serial не показал job)" : "") +
          " · " + when(r.at) + (r.host ? " · " + r.host + (r.os ? " (" + r.os + ")" : "") : "") +
          (r.message ? "\n" + r.message : "") + (r.serial ? "\n" + r.serial.trim().split("\n").slice(0, 4).join("\n") : "");
      if (c && r.version < c.version) t = "ждём агента: версия " + c.version + " ещё не прошита\n" + t;
    }
    $("d-rep").textContent = t;
    fill(d);
  }

  function load(d, fresh) {
    return api("GET", "/api/devices/" + encodeURIComponent(d.id), d.token).then(function (info) { put(d); render(info, d, fresh); });
  }

  $("dev-new").addEventListener("submit", function (e) {
    e.preventDefault();
    var b = e.target.querySelector("button"); b.disabled = true;
    api("POST", "/api/devices", null, { name: e.target.elements.name.value, board: "arduino_uno" })
      .then(function (info) { var d = { id: info.id, token: info.token }; put(d); render(info, d, true); })
      .catch(function (err) { alert("Ошибка: " + err.message); })
      .then(function () { b.disabled = false; });
  });
  $("dev-use").addEventListener("submit", function (e) {
    e.preventDefault();
    var d = { id: e.target.elements.id.value.trim(), token: e.target.elements.token.value.trim() };
    load(d, false).catch(function (err) { alert("Ошибка: " + err.message); });
  });
  $("d-show").addEventListener("click", function () { var d = get(); if (d) $("d-token").textContent = d.token; $("d-show").hidden = true; });
  $("d-refresh").addEventListener("click", function () { var d = get(); if (d) load(d, false).catch(function (err) { $("d-rep").textContent = "Ошибка: " + err.message; }); });
  $("d-forget").addEventListener("click", function () { put(null); fill(null); $("dev-box").hidden = true; $("dev-none").hidden = false; });
  $("d-delete").addEventListener("click", function () {
    var d = get(); if (!d || !confirm("Удалить устройство " + d.id + " и опубликованную прошивку? Агент перестанет обновлять плату.")) return;
    api("DELETE", "/api/devices/" + encodeURIComponent(d.id), d.token)
      .then(function () { put(null); fill(null); $("dev-box").hidden = true; $("dev-none").hidden = false; })
      .catch(function (err) { alert("Ошибка: " + err.message); });
  });

  var d = get();
  if (d) load(d, false).catch(function (err) { $("dev-none").hidden = false; $("d-rep").textContent = ""; console.warn(err); });
})();
