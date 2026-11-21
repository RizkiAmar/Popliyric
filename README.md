# Popliyric

Popliyric is a Spicetify extension that opens a compact, floating lyric player in Spotify. Use the Popliyric waveform button in Spotify's top bar to open the player while music is playing.

## Features

- **Compact pill:** square album artwork with a vinyl record sliding out from behind it (it spins while music plays), the current lyric line in the middle, and an expand button.
- **Expanded view:** large artwork, a **Next** chip showing the upcoming track, a glass **Lyrics** panel that follows the current line, and a bottom bar with title, artist, Previous, Play/Pause, Next, and playback progress.
- Synchronized lyrics with a vertical highlight that follows the current line; unsynchronized lyrics are shown without it.
- Title and artist when Spotify does not provide lyrics.
- A background gradient built from two or three colors of the album artwork, kept dark enough for readable white text.
- Respects the system **reduce motion** setting (the vinyl stops spinning and transitions are skipped).

## Install from Spicetify Marketplace

1. Open Spotify.
2. Open **Spicetify Marketplace** from Spotify's sidebar.
3. Select **Extensions**.
4. Search for **Popliyric**.
5. Select **Install**.

See the [Spicetify Marketplace guide](https://spicetify.app/docs/customization/marketplace) for help using Marketplace.

## Manual installation on Windows

Make sure Spotify and Spicetify are installed. Open PowerShell and run:

```powershell
$extensionPath = "$env:APPDATA\spicetify\Extensions"
New-Item -ItemType Directory -Force -Path $extensionPath | Out-Null

Invoke-WebRequest `
  -Uri "https://raw.githubusercontent.com/RizkiAmar/Popliyric/main/popliyric.js" `
  -OutFile "$extensionPath\popliyric.js"

spicetify config extensions popliyric.js
spicetify apply
```

## Update on Windows

Run these commands in PowerShell to download the latest extension file and apply it:

```powershell
Invoke-WebRequest `
  -Uri "https://raw.githubusercontent.com/RizkiAmar/Popliyric/main/popliyric.js" `
  -OutFile "$env:APPDATA\spicetify\Extensions\popliyric.js"

spicetify apply
```

## Usage

1. Play a track in Spotify.
2. Select the **Popliyric** waveform button in the top bar.
3. Select the chevron on the right of the pill to expand the player, and the chevron in the **Lyrics** panel to collapse it.
4. Drag the player to move the window. The window size is fixed; if you resize it by hand, it snaps back.
5. Use the playback controls in the expanded view.
6. Select the Popliyric button again or close the PiP window to dismiss the player.

## Requirements

- Spotify desktop.
- Spicetify installed and applied.
- A Spotify version that supports Document Picture-in-Picture for the floating player.

## Troubleshooting

**Popliyric does not appear in Spotify**

- Confirm that Spicetify is applied and `popliyric.js` is enabled.
- Restart Spotify after manual installation or update.

**The player does not open**

- Open it by selecting the Popliyric button in Spotify; the browser requires a user action to open a PiP window.
- Check that your Spotify version supports Document Picture-in-Picture.

**Lyrics are missing or the highlight does not move**

- Spotify may not provide lyrics for the selected track. Popliyric shows track details when lyrics are unavailable.
- The vertical highlight requires timed lyrics. Unsynchronized lyrics are shown without it.

**The player does not change size when expanding**

- Some Spotify versions block PiP resizing. Popliyric shows a notification; resize the window by hand and select the chevron again. In a small window the expanded view keeps the playback bar and a collapse button.

**The Next chip is missing**

- The chip appears only when Spotify reports an upcoming track in the queue.

## Known limitations

- Lyrics depend on Spotify's Color Lyrics service, which Spotify may change or make unavailable.
- Document Picture-in-Picture behavior, including window placement and resizing, is controlled by Spotify's embedded browser and may vary between versions.
- The floating player must be opened with a click. It does not reproduce a desktop app's native hover behavior.

## Credits and license

Popliyric is built for [Spicetify](https://spicetify.app/) and uses Spotify's playback and lyric services. See [LICENSE](LICENSE) for the MIT License.

## Project structure

```text
popliyric.js       Spicetify extension
manifest.json      Marketplace metadata
preview.svg        Illustrative player preview
README.md          User guide
CONTRIBUTING.md    Contribution guidance
CHANGELOG.md       Release history
LICENSE            MIT License
.gitignore         Ignore rules
```

The preview is an illustration of the Popliyric interface, not a screenshot of Spotify.
