# Website authentication probe

A standalone diagnostic for Gemini (`https://gemini.google.com/`) and Muse (`https://muse.ai/`). It uses Electron 44.10.1 and T3 Code's existing sandboxed webview preferences. It does not start a T3 server or access the installed T3 database. It is a compatibility probe, not the finished pinned-thread feature or a complete reproduction of T3's browser manager/preloads.

From this directory:

```powershell
npm install --workspaces=false
npm test
npm start
```

Sign in directly in each pane. Authentication popups use that pane's profile. Mark **Signed in**, **Login blocked**, or **Signed out** based on the visible website. Restart using the toolbar, then inspect and record the result again. A successful page load is never treated as successful authentication. Opening a service externally does not transfer its session back to the pane.

The two browser profiles live under this directory's ignored `.data/chromium`. Browser storage may contain real session credentials; keep this directory private. No existing Chrome, Edge, or T3 profiles are imported. The exported report contains provider origins and user-observed outcomes, not credentials, cookies, page content, or URL paths/query strings. Logging is limited to Electron's own runtime diagnostics; do not publish raw terminal output from real sign-in attempts without reviewing it.

The synthetic test launches and cleanly quits two separate Electron processes against one loopback fixture. It checks persistent HttpOnly cookies, host-only attributes, localStorage survival, and profile isolation. It measures session-cookie survival without modifying expirations. It does not prove Gemini or Muse login works. It leaves synthetic test data in a uniquely named system temporary directory.

Google may reject embedded sign-in. Muse compatibility, MFA, passkeys, real login persistence and the full T3 desktop integration require interactive checks. Microphone, camera, notifications and geolocation permissions are denied in this auth-only probe.
