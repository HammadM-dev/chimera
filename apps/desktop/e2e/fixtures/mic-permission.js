// Enumerated before requesting, because the two failure modes are different
// and only one of them says anything about permissions. On a machine with no
// audio input device — every GitHub Actions runner, for instance —
// getUserMedia rejects with NotFoundError before Electron's permission
// handler is consulted at all, so a "denied" outcome there proves nothing.
// The count lets the test tell "denied by policy" from "no such device"
// instead of treating both as a pass.
window.__micPermissionSettled = false;
navigator.mediaDevices
  .enumerateDevices()
  .then((devices) => {
    window.__audioInputCount = devices.filter((d) => d.kind === 'audioinput').length;
    return navigator.mediaDevices.getUserMedia({ audio: true });
  })
  .then(() => {
    window.__micPermissionSettled = true;
    window.__micPermissionOutcome = 'granted';
  })
  .catch((err) => {
    window.__micPermissionSettled = true;
    window.__micPermissionOutcome = 'denied';
    window.__micPermissionErrorName = err && err.name;
  });
