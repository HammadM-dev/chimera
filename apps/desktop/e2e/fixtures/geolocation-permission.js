// Geolocation needs no hardware, so unlike getUserMedia it reaches Electron's
// permission request handler on any machine — including a CI runner with no
// microphone, where a mic probe fails with NotFoundError before permissions are
// ever consulted. This is the probe that proves the deny-by-default handler is
// actually wired, everywhere the suite runs.
window.__geoSettled = false;
navigator.geolocation.getCurrentPosition(
  () => {
    window.__geoSettled = true;
    window.__geoOutcome = 'granted';
  },
  (err) => {
    window.__geoSettled = true;
    window.__geoOutcome = 'denied';
    window.__geoErrorCode = err && err.code;
  },
);
