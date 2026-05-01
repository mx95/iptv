# Multi‑platform shells (mobile & TV)

The UI lives in **`../viewer`**. Playlist URLs and Xtream use **`/api/*`**, implemented by **`npm run viewer`** in the repo root. Point TVs, browsers, or WebViews at the same origin that serves **`viewer`** and **`/api`**.

---

## iOS / Android — Capacitor

```bash
cd mobile
npm install
npx cap add ios      # Xcode on macOS only
npx cap add android
npm run sync
```

**Dev on a device**: start the viewer on your LAN:

```bash
cd ..
VIEWER_HOST=0.0.0.0 VIEWER_PORT=8790 npm run viewer
```

Then in `mobile/capacitor.config.json` add temporarily:

```json
"server": {
  "url": "http://YOUR_PC_LAN_IP:8790",
  "cleartext": true,
  "androidScheme": "https"
}
```

Run `npm run sync` again. Playlist “Load URL” calls `fetch('/api/...')`, so the HTML and API **must share one host**.

**Production / App Store**: serve `viewer` + API over HTTPS, or integrate a Capacitor native HTTP plugin for playlist fetching (pure static WebViews cannot reach arbitrary M3U URLs when CORS blocks them).

---

## Samsung Tizen · LG webOS · other TVs

Samsung ([Seller Office](https://seller.samsungapps.com/) / Tizen web app) and LG ([webOS TV Developer](https://webostv.developer.lge.com/)) expect hosted or packaged web apps. Reuse **`viewer`**; tune focus and oversized UI for remote control.

Bind the server with **`VIEWER_HOST=0.0.0.0`** and open **`http://home-server-ip:8790`** in the TV browser if allowed. Non‑HTTPS and mixed‑content limits vary—use HTTPS + reverse proxy if the TV rejects HTTP.

---

## Android TV · Fire TV

Prefer the Capacitor **Android TV**/`leanback`-style APK, or embed a fullscreen WebView with the same LAN URL above.

---

## Apple TV

Capacitor’s tvOS coverage is thin. Prefer **Swift + AVPlayer**, **React Native + react-native-video**, or Safari-based flows for simple cases.

---

**Legal**: [iptv-org/iptv](https://github.com/iptv-org/iptv) lists publicly submitted stream links ([PLAYLISTS](https://iptv-org.github.io/iptv/), [PLAYLISTS.md](https://github.com/iptv-org/iptv/blob/master/PLAYLISTS.md)); follow their FAQ and notices. Separate rules apply for paid Xtream subscriptions.
