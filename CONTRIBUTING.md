# Contributing to Popliyric

Thanks for your interest in improving Popliyric. Contributions should preserve the original compact island identity and keep the extension lightweight.

## Development environment

- Windows, macOS, or Linux.
- Spotify desktop with Spicetify installed.
- A Spotify build that supports the Document Picture-in-Picture API for UI testing.
- A text editor and a JavaScript syntax checker. There is no package install or build step.

## Local installation

1. Copy `popliyric.js` to the Spicetify `Extensions` directory.
2. Enable it with `spicetify config extensions popliyric.js`.
3. Run `spicetify apply` and restart Spotify if necessary.
4. Open **Popliyric** from Spotify's top bar and test with real playback.

## Coding conventions

- Keep all user-facing strings, comments, and documentation in English.
- Use the existing Spicetify Player API before adding another integration.
- Keep Spotify's current playback position as the source of truth; do not accumulate elapsed time from a stale position.
- Guard asynchronous lyric responses against track changes and avoid duplicate timers or listeners.
- Escape lyric text by assigning `textContent`; do not inject lyrics as HTML.
- Preserve accessible labels for controls and a readable reduced-motion experience.
- Avoid adding dependencies or build steps unless they are necessary and documented.
- Document browser and Spotify runtime limitations instead of relying on unsupported APIs.

## Bug reports

Include:

- Spotify and Spicetify versions and operating system.
- Track URI or a public track link, if the issue is track-specific.
- Whether lyrics are synchronized, unsynchronized, or missing.
- Steps to reproduce and the observed result.
- Relevant `[Popliyric]` console messages with private information removed.

Do not include account tokens, cookies, credentials, or private API keys in an issue.

## Feature proposals

Describe the user problem, expected behavior, and any effect on the compact or expanded layout. Check the known limitations before proposing a feature that depends on browser-controlled window placement or private Spotify APIs.

## Pull requests

- Keep each change focused and explain the reason for it.
- Update the README or changelog when user-visible behavior changes.
- Run a JavaScript syntax check and test the change inside Spotify when possible.
- Report which test cases were run and distinguish live results from static checks.
- Do not remove or rewrite the original Electron reference as part of a native-extension change.
