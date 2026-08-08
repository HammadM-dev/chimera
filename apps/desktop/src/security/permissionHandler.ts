import type { Session } from 'electron';

// DECISION (docs/SECURITY.md section 7): deny every permission request
// except desktop notifications — humanApproval nodes and run-completion
// events (F7.3, F9) depend on OS notifications. The app has no legitimate
// use for any other permission category; deny-by-default means a future
// dependency or renderer bug requesting one of them fails closed.
const ALLOWED_PERMISSIONS = new Set<string>(['notifications']);

export function applyPermissionHandler(session: Session): void {
  session.setPermissionRequestHandler((_webContents, permission, callback) => {
    if (ALLOWED_PERMISSIONS.has(permission)) {
      callback(true);
      return;
    }
    console.warn(`[security] denied permission request: ${permission}`);
    callback(false);
  });

  session.setPermissionCheckHandler((_webContents, permission) =>
    ALLOWED_PERMISSIONS.has(permission),
  );
}
