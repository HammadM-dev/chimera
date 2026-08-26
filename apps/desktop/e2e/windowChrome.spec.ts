import { test, expect } from '@playwright/test';
import { existsSync } from 'node:fs';
import { freshProfile, launchApp, removeProfile } from './support/app.ts';

// The frame around the app.
//
// There was no application menu, which does not mean there was no menu — it
// means Electron built its own default: a white File/Edit/View/Window strip
// across the top of a dark application, holding entries for a text editor.
//
// Asserted in the main process rather than by screenshot, because a screenshot
// of the page cannot see the window chrome at all. That is exactly why this is
// the kind of thing that ships wrong.

test.describe.configure({ timeout: 120_000 });

test('the menu bar is out of the way, and its shortcuts still exist', async () => {
  const profile = freshProfile();
  const app = await launchApp({ profile });

  try {
    await app.firstWindow();

    const chrome = await app.evaluate(({ BrowserWindow, Menu }) => {
      const win = BrowserWindow.getAllWindows()[0];
      const menu = Menu.getApplicationMenu();
      return {
        platform: process.platform,
        menuBarVisible: win?.isMenuBarVisible() ?? true,
        autoHide: win?.autoHideMenuBar ?? false,
        // A menu still exists — hiding the bar without replacing the menu
        // would take copy, paste, select all and quit with it, since on
        // Windows and Linux those accelerators are delivered by the menu
        // whether or not anybody can see it.
        labels: (menu?.items ?? []).map((item) => item.label),
        editRoles: (menu?.items ?? [])
          .find((item) => item.label === 'Edit')
          ?.submenu?.items.map((item) => item.role ?? '')
          .filter((role) => role !== ''),
      };
    });

    expect(chrome.labels, 'no application menu was set at all').toContain('Edit');
    // Electron reports roles lower-cased, whatever case they were written in.
    expect(chrome.editRoles?.map((role) => role.toLowerCase())).toEqual(
      expect.arrayContaining(['undo', 'cut', 'copy', 'paste', 'selectall']),
    );

    // macOS puts its menu in the system bar rather than in the window, and an
    // app without one is broken there — so the hiding is only claimed where it
    // is possible.
    if (chrome.platform !== 'darwin') {
      expect(chrome.menuBarVisible, 'the white menu strip is still showing').toBe(false);
      expect(chrome.autoHide, 'Alt should still bring the menu back').toBe(true);
    }
  } finally {
    await app.close();
    removeProfile(profile);
  }
});

test('the app icon the window is given is a file that exists', async () => {
  // The failure this catches is silent: a wrong path means Electron falls back
  // to its own icon and says nothing. `build/` is electron-builder's resources
  // directory and is not packaged, so the development path and the packaged
  // path are different — which is exactly the shape of thing that works in a
  // checkout and ships broken.
  const profile = freshProfile();
  const app = await launchApp({ profile });

  try {
    await app.firstWindow();

    // The paths come from main; the existence check happens here, because the
    // evaluate context has no module loader and so cannot import `fs`.
    const candidates = await app.evaluate(({ app: electronApp }) => {
      const appPath = electronApp.getAppPath();
      return [`${appPath}/dist/icon.png`, `${appPath}/build/icon.png`, `${appPath}/icon.png`];
    });

    const found = candidates.filter((candidate) => existsSync(candidate));

    expect(found.length, 'no icon.png was found anywhere the window could load it').toBeGreaterThan(
      0,
    );
  } finally {
    await app.close();
    removeProfile(profile);
  }
});
