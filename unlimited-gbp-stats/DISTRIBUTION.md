# Distribution

How this extension reaches users, and why it is done this way.

## Decision: Chrome Web Store

**Self-hosted auto-update does not work for our users, and cannot be made to
work.** Chrome on Windows and macOS refuses to install or run extensions that
did not come from the Web Store, unless the machine is enrolled in enterprise
policy (`ExtensionInstallForcelist` / `ExtensionInstallAllowlist`). Our buyers
are agencies and small-business owners on ordinary consumer Chrome. Asking each
of them to apply a Windows Group Policy or a macOS configuration profile before
they can install a marketing tool is not a distribution channel.

The `update_url` mechanism only does anything for extensions installed from the
Web Store or force-installed by policy. For an unpacked developer load — which
is how the extension currently runs — it is ignored entirely.

So: **the Chrome Web Store is the distribution channel.** It signs the package,
hosts it, and pushes updates to every user without any of this machinery.

### Consequences of that decision

- **`update_url` must NOT appear in `manifest.json`.** The Web Store rejects
  uploads whose manifest contains it. `build-zip.ps1` fails the build if it
  finds one, so a rejected upload is caught here rather than after the wait.
- **`updates.xml` and a self-hosted `.crx` are not needed.** If one is ever
  reintroduced, note that the `codebase` attribute must point at a **`.crx`**,
  not a `.zip` — Chrome's update protocol cannot install from a zip. An earlier
  attempt pointed at `extension.zip` and would never have installed anything.
- GitHub Releases remain useful as a record of what shipped, and as a way to
  hand a build to someone for manual `Load unpacked` testing. They are not the
  update channel.

## ⚠️ The extension ID changes when you publish — this breaks Google sign-in

Read this before the first upload.

The extension currently runs unpacked, so Chrome derives its ID from the folder
path. Today that is `mijkelehhdboakkcekamkmcpahnppldh`. **Publishing to the Web
Store assigns a different, permanent ID.**

Google sign-in depends on that ID. `background.js` calls
`chrome.identity.getRedirectURL()`, which returns:

```
https://<extension-id>.chromiumapp.org/
```

That exact URL must be registered as an authorised redirect URI on the OAuth
client (`512083455568-...apps.googleusercontent.com`) in Google Cloud Console.
When the ID changes, the redirect URI changes with it, and **every store user's
sign-in fails with a redirect_uri_mismatch** until the new one is registered.

### Do this in order

1. Upload the build to the Web Store and get the assigned extension ID from the
   developer dashboard — **before** submitting for review, while the item is
   still a draft.
2. Add `https://<new-id>.chromiumapp.org/` to the OAuth client's authorised
   redirect URIs in Google Cloud Console. Keep the existing one so local
   unpacked development keeps working.
3. Only then submit for review.

Optionally, pin the ID so unpacked development and the published build share
one: copy the item's public key from the developer dashboard into a `"key"`
field in `manifest.json`. This is a *public* key and is safe to commit — but it
changes the unpacked ID, so re-register the redirect URI if you add it.

## Release process

```bash
powershell -ExecutionPolicy Bypass -File unlimited-gbp-stats/build-zip.ps1
```

1. Bump `version` in `manifest.json` (SemVer — see the repo rules; the Web Store
   refuses an upload whose version is not higher than the published one).
2. Add a `CHANGELOG.md` entry.
3. Run the tests: `for f in unlimited-gbp-stats/*.test.js; do node "$f"; done`
4. Build the zip with the command above. It ships only the files the manifest
   actually loads — no tests, no `server/`, no `.bak` files. A store reviewer
   asks about unused files, and the frozen legacy `server/` has no business in
   a published package.
5. Upload `dist/unlimited-gbp-stats-<version>.zip` to the Web Store dashboard.
6. Tag the commit and attach the same zip to a GitHub Release for the record.

## Before the first submission

Still outstanding, from the README's own checklist:

- A privacy policy URL. The extension reads Google Business Profile data and
  sends review text to our backend, so the listing must say so plainly.
- Screenshots and store listing copy.
- A justification for each permission. `tabs` and the broad `https://*.google.com/*`
  host permission attract the most review scrutiny — be ready to explain why
  narrower ones do not work, or narrow them.
