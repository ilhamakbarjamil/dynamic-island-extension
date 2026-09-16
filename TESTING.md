# Dynamic Island: settings and testing

After installing these changes, reload the extension code (log out and back in on Wayland).
Open preferences:

```sh
gnome-extensions prefs dynamic-island@ilhamakbarjamil.github.com
```

Preferences apply immediately: popup duration, scale, horizontal position, top margin,
and individual features. Disabling custom notifications restores the prior system banner preference.

## Simulations

Run from this extension directory:

```sh
./tools/island-test enable
./tools/island-test mount
./tools/island-test bluetooth
./tools/island-test notification
./tools/island-test download
./tools/island-test privacy
./tools/island-test vpn
./tools/island-test workspace
./tools/island-test reset
./tools/island-test disable
```

Run one simulation at a time. The test endpoint is disabled by default and only accepts
these fixed scenarios. No drive mounts, Bluetooth/VPN changes, downloads, camera access,
or outgoing messages occur. Feature switches still apply. Real privacy updates take precedence.

## Automated checks

```sh
node tests/popup-queue.mjs
gjs -m tests/check-settings.js
glib-compile-schemas --strict --dry-run schemas
```

## Live checks

- Send a notification while a lower-priority popup is visible. Notifications take priority;
  lower-priority events wait, with at most one pending event per feature and a 15-second expiry.
- Open Control Center and trigger a simulation; close it to see the pending popup.
- Enable camera and microphone while playing music: the privacy capsule must remain visible.
- Test scales 0.8, 1.0 and 1.5, including long notification titles and monitor changes.
- Toggle each feature off/on and disable/re-enable the extension; check for lingering callbacks.
- Pause music and confirm the normal view returns after five seconds.

Hardware detection and visual smoothness require a live GNOME session. Camera fallback checks
whether a process holds a video device open; it cannot prove frames are being captured.
No idle CPU benchmark has been recorded. Media position/wave updates are now limited to visible
media views; disabled download, VPN and privacy watchers stop their polling.
