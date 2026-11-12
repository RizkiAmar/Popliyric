# Popliyric

Popliyric is a Spicetify extension that opens a compact, floating lyric player in Spotify. Use the Popliyric waveform button in Spotify's top bar to open the player while music is playing.

## Features

- Synchronized lyrics with a vertical highlight that follows the current line.
- Unsynchronized lyrics shown without the timed highlight.
- Track and album details when Spotify does not provide lyrics.
- Album artwork inside a vinyl record animation.
- Player colors adapted to the album artwork.
- Previous, Play/Pause, and Next controls, plus playback progress.
- Compact and expanded player views.

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
3. Click the player to expand or collapse it.
4. Use the playback controls in the expanded view.
5. Select the Popliyric button again or close the PiP window to dismiss the player.

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
