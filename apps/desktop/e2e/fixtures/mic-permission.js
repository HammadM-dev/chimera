window.__micPermissionSettled = false;
navigator.mediaDevices
  .getUserMedia({ audio: true })
  .then(() => {
    window.__micPermissionSettled = true;
    window.__micPermissionOutcome = 'granted';
  })
  .catch((err) => {
    window.__micPermissionSettled = true;
    window.__micPermissionOutcome = 'denied';
    window.__micPermissionErrorName = err && err.name;
  });
