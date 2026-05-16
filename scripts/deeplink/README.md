# Deep link verification files

These files have to be hosted under `/.well-known/` on the domain that's
listed in the Flutter app's intent-filter (Android) and associated-domains
entitlement (iOS) — currently `jobhunter.app`. Once the OS verifies them
the matching URLs open the app directly with no "Open with..." picker.

## Files

- `assetlinks.json` — Android App Links manifest
- `apple-app-site-association` — iOS Universal Links manifest (no
  extension; must be served as `application/json` with no redirects)

## Required URLs (live by the time you publish a release build)

- `https://jobhunter.app/.well-known/assetlinks.json`
- `https://jobhunter.app/.well-known/apple-app-site-association`

Both must be reachable over HTTPS on the **apex domain** (not just
`www.`), respond `200 OK`, return `Content-Type: application/json`, and
must not redirect — the Android / iOS verifiers stop on the first hop.

## Before publishing

1. **assetlinks.json**
   - Replace `package_name` with the Android applicationId from
     `android/app/build.gradle` (currently `com.example.job_hunter`).
   - Replace the SHA-256 fingerprint with the one from your **release**
     keystore:
     ```bash
     keytool -list -v \
       -keystore /path/to/release.keystore \
       -alias <key alias> | grep SHA-256
     ```
     Use the colon-separated hex form Google expects (e.g.,
     `12:34:56:...`).
   - If you also distribute via Play App Signing, add a second entry
     with the SHA-256 Google Play shows under "App signing key
     certificate" in the Play Console.

2. **apple-app-site-association**
   - Replace `REPLACE_TEAM_ID` with your Apple Developer Team ID
     (visible in the membership page on
     <https://developer.apple.com/account>).
   - Replace `com.example.job_hunter` with the iOS bundle identifier
     from `ios/Runner.xcodeproj/project.pbxproj` →
     `PRODUCT_BUNDLE_IDENTIFIER`.

3. Open `ios/Runner.xcworkspace` and add `Runner.entitlements` to the
   project's Code Signing Entitlements (Signing & Capabilities → +
   Capability → Associated Domains). Verify the
   `applinks:jobhunter.app` entry is present.

4. Push a release build that uses the keystore whose SHA-256 fingerprint
   you put in `assetlinks.json`. App Links are only verified against
   the production-signed APK / AAB.

## Verifying

- **Android**: `adb shell pm get-app-links com.example.job_hunter` —
  should print `verified` for the `jobhunter.app` host once the
  manifest is reachable.
- **iOS**: tap a `https://jobhunter.app/job/<id>` link inside Notes or
  Messages — the OS will open the app directly when the AASA file is
  valid and the entitlement matches.

## Marketing fallback page

The same domain should serve a marketing page at `https://jobhunter.app`
(and at `/job/<id>`) with **Open in App** + **Get on Google Play** +
**Download on App Store** buttons. That way a recipient who taps the
link without the app installed lands on a useful page instead of a 404,
and once they install via the Store the same link opens the right
screen.
