# Changelog

## [2.0.0] - Unreleased

Redesigned player interface. Lyric, track, and playback logic are unchanged.

### Changed

- The compact and expanded players fill the whole PiP window, so no dark window corners show around a rounded shape.
- The window keeps a fixed size: if it is resized by hand, it snaps back to the size of the current view, and the layout does not stretch while resizing.
- Rebuilt the compact player (390 x 82 window): square album artwork on the left, a grooved vinyl with an artwork label sliding out from behind it and spinning while music plays, the current lyric centered on up to two lines in a larger font with the existing line wipe, and an expand chevron on the right.
- Player colors now use a horizontal gradient of two or three dominant artwork colors, darkened to keep white text readable, with a neutral gradient when no artwork is available.
- Rebuilt the expanded view (460 x 352 window): 150 px artwork with a **Next** chip for the upcoming track, a glass **Lyrics** panel with a collapse button and a blue marker on the active line, and a glass bottom bar with title, artist, playback controls, and progress.
- The glass effect is drawn from blurred artwork behind semi-transparent panels, so it does not depend on `backdrop-filter` support in the PiP window.
- The player expands and collapses only from the chevron buttons. Clicking elsewhere no longer toggles the view; dragging still moves the window.
- Tracks without lyrics show the title and artist in the pill and a short notice in the Lyrics panel. Tracks without artwork show a neutral placeholder and a plain vinyl.

### Fixed

- Lyrics that arrive on a retry for the same track are now displayed instead of leaving an empty list.
- Centering the active lyric no longer scrolls the whole expanded card.
- Reopening the player on the same track loads the artwork and its colors again instead of showing the placeholder.

## [1.0.0] - 2026-11-13

Initial stable release.

### Features

- Added a Spotify top bar waveform button that opens the Popliyric player in a Document Picture-in-Picture window.
- Added timed lyrics with a vertical highlight and regular display for unsynchronized lyrics.
- Added a track information view for tracks without available lyrics.
- Added compact and expanded player views with album details, playback progress, and previous, Play/Pause, and next controls.
- Added album artwork in an animated vinyl record and adaptive player colors sampled from the artwork.
- Kept the Play/Pause icon synchronized with Spotify playback state.

### Limitations

- Lyrics depend on Spotify's Color Lyrics service and may not be available for every track.
- Document Picture-in-Picture support and window behavior depend on the Spotify runtime.
