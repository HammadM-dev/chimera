import { Menu, shell, type BrowserWindow } from 'electron';

// The application menu.
//
// There was none, which does not mean there was no menu — it means Electron
// built its own default one: a white File/Edit/View/Window strip across the top
// of a dark application, holding entries for a text editor rather than for
// this. Hiding it without replacing it would have taken copy, paste, select
// all and quit with it, since on Windows and Linux those accelerators are
// delivered by the menu whether or not anybody can see it.
//
// So: a real menu, with the roles that carry the shortcuts people expect, and
// hidden by default on the platforms where hiding is possible. Alt still shows
// it, which is the convention on both.
//
// macOS is different and is left alone. Its menu is the system bar rather than
// part of the window, an application without one is a broken application there,
// and the first submenu has to be the app menu or the platform behaves oddly.

export function applyApplicationMenu(): void {
  const isMac = process.platform === 'darwin';

  const menu = Menu.buildFromTemplate([
    ...(isMac
      ? [{ role: 'appMenu' as const }]
      : [
          {
            label: 'File',
            submenu: [{ role: 'quit' as const }],
          },
        ]),
    {
      label: 'Edit',
      // Roles rather than hand-written accelerators: `role` gives the right
      // key on each platform and wires it to the focused input, which a
      // hand-rolled entry does not.
      submenu: [
        { role: 'undo' as const },
        { role: 'redo' as const },
        { type: 'separator' as const },
        { role: 'cut' as const },
        { role: 'copy' as const },
        { role: 'paste' as const },
        { role: 'selectAll' as const },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' as const },
        { role: 'resetZoom' as const },
        { role: 'zoomIn' as const },
        { role: 'zoomOut' as const },
        { type: 'separator' as const },
        { role: 'togglefullscreen' as const },
        // Deliberately kept. A desktop app whose renderer cannot be inspected
        // is one nobody can diagnose a report against, and this is a build a
        // founder runs on his own machine.
        { role: 'toggleDevTools' as const },
      ],
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'Composio setup',
          click: () => {
            void shell.openExternal('https://docs.composio.dev');
          },
        },
      ],
    },
  ]);

  Menu.setApplicationMenu(menu);
}

/**
 * Hides the menu bar, where the platform has one inside the window.
 *
 * `autoHide` rather than removing it: Alt brings it back, which is what
 * somebody looking for it will try, and the accelerators keep working either
 * way.
 */
export function hideMenuBar(win: BrowserWindow): void {
  if (process.platform === 'darwin') return;
  win.setMenuBarVisibility(false);
  win.autoHideMenuBar = true;
}
