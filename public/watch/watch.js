// watch.js — /watch/?w=<week_of>&v=<id> (spec 2026-10-12 §3.3).
// One <video> plays /this-week/<w>/<v>.mp4. When it ends or cannot play, the
// hub's log hears it first, then ERAgaze (127.0.0.1:49155) is told the video is
// over and takes the screen back. Bad params: a blank page that ends the watch
// after a second, so a broken tile never strands her on a black screen.
(function () {
  "use strict";
  var ENGINE = "http://127.0.0.1:49155/app/watch-end";
  var q = new URLSearchParams(location.search);
  var week_of = q.get("w") || "", id = q.get("v") || "";
  var ended = false;

  // a simple CORS request (no headers), as board-render.js's launchMovie does:
  // the engine never has to answer a preflight
  function watchEnd() {
    return fetch(ENGINE, { method: "POST", body: JSON.stringify({ reason: "video-ended" }) }).catch(function () {});
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(week_of) || !/^[A-Za-z0-9_-]{11}$/.test(id)) {
    setTimeout(watchEnd, 1000);
    return;
  }

  var video = document.createElement("video");
  video.autoplay = true;
  video.setAttribute("autoplay", "");
  video.setAttribute("playsinline", "");
  video.src = "/this-week/" + week_of + "/" + id + ".mp4";
  document.body.appendChild(video);

  if ("mediaSession" in navigator && navigator.mediaSession) {
    try {
      navigator.mediaSession.setActionHandler("play", function () { video.play().catch(function () {}); });
      navigator.mediaSession.setActionHandler("pause", function () { video.pause(); });
    } catch (e) {}
  }

  function playedMs() {
    var ms = 0, r = video.played;
    try { for (var i = 0; i < r.length; i++) ms += (r.end(i) - r.start(i)) * 1000; } catch (e) {}
    return Math.round(ms);
  }

  function finish(event) {
    if (ended) return;
    ended = true;
    var log = fetch("/log", {
      method: "POST", headers: { "Content-Type": "application/json" }, keepalive: true,
      body: JSON.stringify({ app: "this-week", door: "watch", week_of: week_of, id: id, event: event, ms: playedMs() }),
    }).catch(function () {});
    // the log first; a hub that never answers must not keep her watching black
    Promise.race([log, new Promise(function (r) { setTimeout(r, 1500); })]).then(watchEnd);
  }
  video.addEventListener("ended", function () { finish("ended"); });
  video.addEventListener("error", function () { finish("error"); });
})();
