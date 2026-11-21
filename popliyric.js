(async function PopliyricExtension() {
  const LYRICS_HOST = "https://spclient.wg.spotify.com/color-lyrics/v2";
  const DEFAULT_ACCENT = "#7c8493";
  const DEFAULT_SURFACE = "#17191f";
  const PILL_SIZE = { width: 390, height: 82 };
  const EXPANDED_SIZE = { width: 460, height: 352 };
  const DEFAULT_PALETTE =["#46535c", "#2f3d47", "#1f2a32"];
  const COLLAPSE_BUTTON = (extraClass) => `<button type="button" class="island-button ${extraClass}" data-action="toggle-view" data-expanded="true" aria-label="Collapse lyrics" title="Collapse lyrics"><svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M3.25 10L8 5.25 12.75 10" /></svg></button>`;
  const ART_PLACEHOLDER =`<svg class="art-placeholder" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M9 18V6l10-2v12"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="16.5" cy="16" r="2.5"/></svg>`;
  const REFRESH_MS = 500;
  const LYRICS_RETRY_MS = 30_000;
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  while (!window.Spicetify?.Player || !window.Spicetify?.Topbar?.Button) {
    await wait(250);
  }

  if (window.__popliyricExtensionLoaded) return;
  window.__popliyricExtensionLoaded = true;

  const Player = Spicetify.Player;
  const state = {
    pipWindow: null,
    pipOpening: false,
    trackUri: "",
    trackKey: "",
    track: null,
    emptyTrackSince: 0,
    emptyTrackSamples: 0,
    lyrics: [],
    lyricsStatus: "missing",
    lyricsSynced: false,
    lyricsRequestInFlight: false,
    requestVersion: 0,
    lastLyricsAttemptAt: 0,
    expanded: false,
    activeIndex: -1,
    positionMs: 0,
    durationMs: 0,
    isPlaying: false,
    playbackEventOverride: null,
    playbackAnchor: 0,
    wipeFrame: 0,
    refreshTimer: 0,
    artworkUrl: "",
    artworkColors: new Map()
  };

  function normalizeImage(url) {
    if (!url) return "";
    const value = String(url).trim();
    if (!value) return "";
    if (value.startsWith("spotify:image:")) return `https://i.scdn.co/image/${value.split(":").pop()}`;
    if (/^https?:\/\//i.test(value)) return value;
    if (value.startsWith("//")) return `https:${value}`;
    if (value.startsWith("/image/")) return `https://i.scdn.co${value}`;
    if (/^[a-z0-9]{20,}$/i.test(value)) return `https://i.scdn.co/image/${value}`;
    return value;
  }

  function safeText(value, fallback) {
    return typeof value === "string" && value.trim() ? value.trim() : fallback;
  }

  function readTrackFromSpotifyUi() {
    const links = Array.from(document.querySelectorAll('a[href*="uri=spotify"]'));
    let uri = "";
    for (const link of links) {
      try {
        const parsed = new URL(link.href, location.href);
        const candidate = parsed.searchParams.get("uri") || "";
        if (/^spotify:track:[a-z0-9]+$/i.test(candidate)) {
          uri = candidate;
          if (/now playing/i.test(link.getAttribute("aria-label") || "")) break;
        }
      } catch (_) {}
    }

    const nowPlayingWidget = document.querySelector('[data-testid="now-playing-widget"]') ||
      document.querySelector('[data-testid="nowplaying-widget"]');
    const label = links.map((link) => link.getAttribute("aria-label") || "")
      .find((value) => /^now playing:/i.test(value)) || "";
    const labelMatch = label.match(/^now playing:\s*(.+?)\s+by\s+(.+)$/i);
    const titleElement = nowPlayingWidget?.querySelector('[data-testid="context-item-link"]');
    const artistElement = nowPlayingWidget?.querySelector('[data-testid="context-item-info-subtitles"]');
    const pageTitle = document.title.split(" • ");
    const pageHasTrackTitle = pageTitle.length > 1 && !/^spotify(?: web player)?$/i.test(pageTitle[0].trim());
    const title = safeText(labelMatch?.[1] || titleElement?.textContent || (pageHasTrackTitle ? pageTitle[0] : ""), "");
    const artist = safeText(labelMatch?.[2] || artistElement?.textContent || (pageHasTrackTitle ? pageTitle[1] : ""), "");
    const artwork = nowPlayingWidget?.querySelector('img')?.src || "";
    if (!uri && !title) return null;
    return { uri, title, artist, album: "", artwork: normalizeImage(artwork) };
  }

  function trackFromItem(item) {
    if (!item || typeof item !== "object") return null;
    const metadata = item.metadata || {};
    const album = item.album || {};
    const artists = Array.isArray(item.artists)
      ? item.artists.map((artist) => typeof artist === "string" ? artist : artist?.name).filter(Boolean).join(", ")
      : "";
    const track = {
      uri: item.uri || metadata.entity_uri || metadata.uri || "",
      title: safeText(item.name || metadata.title || metadata.track_title, ""),
      artist: artists || safeText(metadata.artist_name || metadata.artist, ""),
      album: safeText(album.name || metadata.album_title || metadata.album_name, ""),
      artwork: normalizeImage(
        album.images?.[0]?.url || metadata.image_url || metadata.image_xlarge_url || metadata.image_large_url || ""
      )
    };
    return track.uri || track.title ? track : null;
  }

  function sameTrack(left, right) {
    if (!left || !right) return false;
    if (left.uri && right.uri) return left.uri === right.uri;
    const leftTitle = left.title?.trim().toLocaleLowerCase();
    const rightTitle = right.title?.trim().toLocaleLowerCase();
    if (!leftTitle || !rightTitle || leftTitle !== rightTitle) return false;
    const leftArtist = left.artist?.trim().toLocaleLowerCase();
    const rightArtist = right.artist?.trim().toLocaleLowerCase();
    return !leftArtist || !rightArtist || leftArtist === rightArtist;
  }

  function readTrack() {
    // Sample current state only; event payloads can describe transient pause/transition state.
    const playerState = Player.data;
    const playerTrack = trackFromItem(playerState?.item || playerState?.track);
    const uiTrack = readTrackFromSpotifyUi();
    const queueTrack = trackFromItem(Spicetify.Queue?.track);
    const primary = playerTrack || uiTrack || queueTrack;
    if (!primary) return null;

    const related = [playerTrack, uiTrack, queueTrack]
      .filter((candidate) => candidate && sameTrack(primary, candidate));
    const firstValue = (field) => related.map((candidate) => candidate[field]).find((value) => typeof value === "string" && value.trim()) || "";
    return {
      uri: firstValue("uri"),
      title: firstValue("title"),
      artist: firstValue("artist"),
      album: firstValue("album"),
      artwork: firstValue("artwork")
    };
  }

  function toTimestamp(value) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : null;
  }

  async function fetchLyrics(uri) {
    const trackId = uri?.split(":").pop();
    if (!trackId) {
      return { lines: [], synced: false };
    }

    const parseLyricsResponse = (response) => {
      const lyricPayload = response?.body?.lyrics || response?.lyrics;
      const sourceLines = Array.isArray(lyricPayload?.lines) ? lyricPayload.lines : [];
      const lines = sourceLines.map((line) => ({
        start: toTimestamp(line.startTimeMs),
        end: toTimestamp(line.endTimeMs),
        text: typeof line.words === "string" ? line.words.trim() : ""
      })).filter((line) => line.text);
      const distinctStartTimes = new Set(lines.map((line) => line.start).filter((start) => start !== null));
      const syncType = String(lyricPayload?.syncType || "").toUpperCase();
      return { lines, synced: syncType === "LINE_SYNCED" || (syncType !== "UNSYNCED" && distinctStartTimes.size > 1) };
    };

    if (Spicetify.Platform?.RequestBuilder) {
      try {
        const response = await Spicetify.Platform.RequestBuilder.build()
          .withHost(LYRICS_HOST)
          .withPath(`/track/${encodeURIComponent(trackId)}`)
          .withQueryParameters({ format: "json", vocalRemoval: false })
          .withEndpointIdentifier("/track/{trackId}")
          .send();
        const result = parseLyricsResponse(response);
        if (result.lines.length) return result;
      } catch (error) {
        console.warn("[Popliyric] RequestBuilder lyrics request failed:", error?.message || error);
      }
    }

    // RequestBuilder can return an empty body for tracks with available lyrics;
    // retry through the authenticated session endpoint used by Spotify's client.
    try {
      const platform = Spicetify.Platform;
      const token = platform?.AuthorizationAPI?.getState?.()?.token?.accessToken;
      if (!token) {
        console.warn("[Popliyric] No Spotify access token available for the lyrics retry.");
        return { lines: [], synced: false };
      }
      const response = await fetch(`${LYRICS_HOST}/track/${encodeURIComponent(trackId)}?format=json&vocalRemoval=false&market=from_token`, {
        headers: {
          Authorization: `Bearer ${token}`,
          "App-Platform": platform.PlatformData?.app_platform || "Win32_x86_64",
          "Spotify-App-Version": platform.version
        }
      });
      if (!response.ok) {
        console.warn("[Popliyric] Lyrics service responded with HTTP", response.status);
        return { lines: [], synced: false };
      }
      return parseLyricsResponse(await response.json());
    } catch (error) {
      console.warn("[Popliyric] Authenticated lyrics retry failed:", error?.message || error);
      return { lines: [], synced: false };
    }
  }

  function cancelWipeAnimation() {
    if (state.wipeFrame) {
      cancelAnimationFrame(state.wipeFrame);
      state.wipeFrame = 0;
    }
  }

  function cacheArtworkColor(url, color) {
    state.artworkColors.delete(url);
    state.artworkColors.set(url, color);
    while (state.artworkColors.size > 40) {
      state.artworkColors.delete(state.artworkColors.keys().next().value);
    }
  }

  function getCurrentIndex(positionMs) {
    if (!state.lyricsSynced || !state.lyrics.length) return -1;
    let active = -1;
    for (let index = 0; index < state.lyrics.length; index += 1) {
      const start = state.lyrics[index].start;
      if (start === null) continue;
      if (positionMs >= start) active = index;
      else break;
    }
    return active < 0 ? 0 : active;
  }

  function getLineEnd(index) {
    const line = state.lyrics[index];
    const next = state.lyrics[index + 1];
    if (line?.end !== null && line?.end > line?.start) return line.end;
    if (next?.start !== null && next?.start > line?.start) return next.start;
    if (state.durationMs > line?.start) return state.durationMs;
    return null;
  }

  function currentWipeProgress() {
    const line = state.lyrics[state.activeIndex];
    const end = getLineEnd(state.activeIndex);
    if (!state.lyricsSynced || !line || line.start === null || end === null || end <= line.start) return null;
    const position = state.positionMs + (state.isPlaying ? performance.now() - state.playbackAnchor : 0);
    return Math.max(0, Math.min(100, ((position - line.start) / (end - line.start)) * 100));
  }

  function applyWipe() {
    const win = state.pipWindow;
    if (!win || win.closed) return;
    const progress = currentWipeProgress();
    const preview = win.document.getElementById("small-primary");
    const activeLine = win.document.querySelector(".lyric-line.active");
    for (const element of [preview, activeLine]) {
      if (!element) continue;
      if (progress === null) {
        element.style.removeProperty("--lyric-progress");
        element.classList.add("static-highlight");
      } else {
        element.style.setProperty("--lyric-progress", `${progress.toFixed(2)}%`);
        element.classList.remove("static-highlight");
      }
    }
    if (state.isPlaying && progress !== null && progress < 100 && !state.wipeFrame) {
      state.wipeFrame = requestAnimationFrame(tickWipe);
    }
  }

  function tickWipe() {
    state.wipeFrame = 0;
    applyWipe();
  }

  function formatTime(milliseconds) {
    const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = String(totalSeconds % 60).padStart(2, "0");
    return `${minutes}:${seconds}`;
  }

  function setArtwork(url) {
    const win = state.pipWindow;
    if (!win || win.closed) return;
    const images = win.document.querySelectorAll("img[data-artwork]");
    if (!url) {
      state.artworkUrl = "";
      for (const image of images) {
        image.removeAttribute("src");
        image.classList.remove("image-error");
        delete image.dataset.source;
        image.style.opacity = "1";
      }
      applyArtworkColor("");
      return;
    }
    for (const image of images) {
      if (image.dataset.source === url) continue;
      image.dataset.source = url;
      image.classList.remove("image-error");
      image.style.opacity = "0.55";
      image.onload = () => {
        if (!state.pipWindow || state.pipWindow.closed || image.dataset.source !== url) return;
        requestAnimationFrame(() => { image.style.opacity = "1"; });
      };
      image.onerror = () => {
        if (image.dataset.source !== url) return;
        image.removeAttribute("src");
        image.classList.add("image-error");
        image.style.opacity = "1";
      };
      image.src = url;
    }
    if (url !== state.artworkUrl) {
      state.artworkUrl = url;
      applyArtworkColor(url);
    }
  }

  function rgbToHsl(red, green, blue) {
    const maximum = Math.max(red, green, blue);
    const minimum = Math.min(red, green, blue);
    const delta = maximum - minimum;
    const lightness = (maximum + minimum) / 2;
    let hue = 0;
    let saturation = 0;
    if (delta > 0) {
      saturation = delta / (1 - Math.abs(2 * lightness - 1));
      if (maximum === red) hue = ((green - blue) / delta) % 6;
      else if (maximum === green) hue = (blue - red) / delta + 2;
      else hue = (red - green) / delta + 4;
      hue = (hue * 60 + 360) % 360;
    }
    return { hue, saturation: Math.min(1, saturation), lightness };
  }

  function hslToRgb(hue, saturation, lightness) {
    const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
    const segment = hue / 60;
    const second = chroma * (1 - Math.abs((segment % 2) - 1));
    const [red, green, blue] = segment < 1 ? [chroma, second, 0]
      : segment < 2 ? [second, chroma, 0]
        : segment < 3 ? [0, chroma, second]
          : segment < 4 ? [0, second, chroma]
            : segment < 5 ? [second, 0, chroma]
              : [chroma, 0, second];
    const offset = lightness - chroma / 2;
    return [red + offset, green + offset, blue + offset];
  }

  function relativeLuminance([red, green, blue]) {
    const linear = (channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    return 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue);
  }

  // Turns a sampled artwork color into a dark tone that keeps white text at a
  // contrast ratio of at least 4.5:1 (relative luminance <= 0.183).
  function toReadableDark({ hue, saturation, lightness }) {
    const isGray = saturation < 0.12;
    const darkSaturation = isGray ? saturation * 0.6 : Math.max(0.26, Math.min(0.7, saturation * 0.85));
    let darkLightness = Math.max(0.1, Math.min(0.3, lightness * 0.5 + 0.06));
    while (darkLightness > 0.05 && relativeLuminance(hslToRgb(hue, darkSaturation, darkLightness)) > 0.15) {
      darkLightness -= 0.02;
    }
    return `hsl(${Math.round(hue)} ${Math.round(darkSaturation * 100)}% ${Math.round(darkLightness * 100)}%)`;
  }

  // Picks up to three dominant artwork colors whose hues are visibly distinct.
  function extractArtworkPalette(image) {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 32;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return null;
    context.drawImage(image, 0, 0, 32, 32);
    const pixels = context.getImageData(0, 0, 32, 32).data;
    const buckets = new Map();
    let sampled = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      if (pixels[index + 3] < 160) continue;
      sampled += 1;
      const key = `${pixels[index] >> 4}:${pixels[index + 1] >> 4}:${pixels[index + 2] >> 4}`;
      const bucket = buckets.get(key) || { count: 0, red: 0, green: 0, blue: 0 };
      bucket.count += 1;
      bucket.red += pixels[index];
      bucket.green += pixels[index + 1];
      bucket.blue += pixels[index + 2];
      buckets.set(key, bucket);
    }
    if (!sampled) return null;

    const candidates = [...buckets.values()].map((bucket) => {
      const hsl = rgbToHsl(bucket.red / bucket.count / 255, bucket.green / bucket.count / 255, bucket.blue / bucket.count / 255);
      const usable = hsl.lightness > 0.06 && hsl.lightness < 0.94;
      return { ...hsl, count: bucket.count, score: bucket.count * (0.3 + 0.7 * hsl.saturation) * (usable ? 1 : 0.15) };
    }).sort((left, right) => right.score - left.score);

    const minimumShare = Math.max(6, sampled * 0.025);
    const hueDistance = (left, right) => Math.min(Math.abs(left - right), 360 - Math.abs(left - right));
    const isDistinct = (candidate, picked) => {
      const candidateGray = candidate.saturation < 0.12;
      const pickedGray = picked.saturation < 0.12;
      if (candidateGray && pickedGray) return Math.abs(candidate.lightness - picked.lightness) >= 0.25;
      if (candidateGray || pickedGray) return true;
      return hueDistance(candidate.hue, picked.hue) >= 28;
    };

    const palette = [];
    for (const candidate of candidates) {
      if (palette.length && candidate.count < minimumShare) continue;
      if (palette.every((picked) => isDistinct(candidate, picked))) palette.push(candidate);
      if (palette.length === 3) break;
    }
    if (!palette.length) return null;
    if (palette.length === 1) {
      const [only] = palette;
      palette.push({ ...only, hue: (only.hue + 18) % 360, lightness: only.lightness * 0.6 });
    }
    return palette.map(toReadableDark);
  }

  function applyPalette(island, palette) {
    if (!island) return;
    const colors = Array.isArray(palette) && palette.length ? palette : DEFAULT_PALETTE;
    const [first, second = first, third = second] = colors;
    island.style.setProperty("--accent", first);
    island.style.setProperty("--c1", first);
    island.style.setProperty("--c2", second);
    island.style.setProperty("--c3", third);
  }

  function applyArtworkColor(url) {
    const win = state.pipWindow;
    if (!win || win.closed) return;
    const island = win.document.getElementById("island");
    if (!url) {
      applyPalette(island, null);
      island.style.setProperty("--surface", DEFAULT_SURFACE);
      return;
    }
    if (state.artworkColors.has(url)) {
      applyPalette(island, state.artworkColors.get(url));
      return;
    }
    const applyIfCurrent = (palette) => {
      if (state.artworkUrl === url && state.pipWindow && !state.pipWindow.closed) {
        applyPalette(state.pipWindow.document.getElementById("island"), palette);
      }
    };
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => {
      let palette = null;
      try { palette = extractArtworkPalette(image); } catch (error) {
        console.warn("[Popliyric] Album color sampling failed:", error?.message || error);
      }
      cacheArtworkColor(url, palette);
      applyIfCurrent(palette);
    };
    image.onerror = () => {
      cacheArtworkColor(url, null);
      applyIfCurrent(null);
    };
    image.src = url;
  }

  function renderLyricMode() {
    const win = state.pipWindow;
    if (!win || win.closed) return;
    const doc = win.document;
    const hasLyrics = state.lyrics.length > 0;
    const isLoading = state.lyricsStatus === "loading";
    const fallback = !hasLyrics && !isLoading;
    const island = doc.getElementById("island");
    island.dataset.mode = fallback ? "track-info" : "lyrics";
    doc.getElementById("lyrics-panel").hidden = !hasLyrics;
    doc.getElementById("lyrics-loading").hidden = hasLyrics || !isLoading;
    doc.getElementById("track-fallback").hidden = !fallback;

    const track = state.track;
    if (track) {
      doc.getElementById("small-primary").textContent = hasLyrics
        ? (state.lyricsSynced
          ? state.lyrics[state.activeIndex]?.text || "Lyrics will appear here"
          : state.lyrics[0]?.text || "Lyrics are not synchronized")
        : (isLoading ? "Loading lyrics…" : track.title || "Loading track…");
      const secondary = doc.getElementById("small-secondary");
      secondary.textContent = hasLyrics || isLoading ? "" : [track.artist, track.album].filter(Boolean).join(" · ");
      secondary.hidden = hasLyrics || isLoading;
      doc.getElementById("track-title").textContent = track.title || "Loading track…";
      doc.getElementById("track-artist").textContent = track.artist;
      doc.getElementById("small-title").textContent = track.title || "Loading track…";
      doc.getElementById("fallback-album").textContent = track.album ? `From ${track.album}` : "";
    } else {
      doc.getElementById("small-primary").textContent = "No track playing";
      doc.getElementById("small-title").textContent = "No track playing";
      doc.getElementById("small-secondary").textContent = "";
      doc.getElementById("small-secondary").hidden = true;
      doc.getElementById("track-title").textContent = "No track playing";
      doc.getElementById("track-artist").textContent = "Play a song in Spotify";
      doc.getElementById("fallback-album").textContent = "";
    }

    const list = doc.getElementById("lyrics-list");
    if (!hasLyrics) {
      list.replaceChildren();
      // Forget the rendered track so a later retry for the same URI rebuilds the lines.
      delete list.dataset.uri;
      state.activeIndex = -1;
      return;
    }
    list.classList.toggle("unsynced", !state.lyricsSynced);
    if (list.dataset.uri !== state.trackUri) {
      list.dataset.uri = state.trackUri;
      list.parentElement.scrollTop = 0;
      list.replaceChildren(...state.lyrics.map((line, index) => {
        const element = doc.createElement("div");
        element.className = "lyric-line";
        element.dataset.index = String(index);
        element.textContent = line.text;
        return element;
      }));
      state.activeIndex = -1;
    }

    const active = state.lyricsSynced ? getCurrentIndex(state.positionMs) : -1;
    if (active !== state.activeIndex) {
      state.activeIndex = active;
      list.querySelectorAll(".lyric-line").forEach((line, index) => {
        line.classList.toggle("active", index === active);
      });
      if (active >= 0 && state.expanded) scrollActiveLine(true);
    }
    applyWipe();
  }

  // Centres the active line inside the lyrics panel only. scrollIntoView() could
  // also scroll the overflow-hidden card, which shifts the whole layout.
  function scrollActiveLine(smooth) {
    const win = state.pipWindow;
    if (!win || win.closed) return;
    const scroller = win.document.getElementById("lyrics-panel");
    const line = scroller?.querySelector(`[data-index="${state.activeIndex}"]`);
    if (!line || !scroller.clientHeight) return;
    const reduceMotion = win.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    scroller.scrollTo({
      top: line.offsetTop - (scroller.clientHeight - line.offsetHeight) / 2,
      behavior: smooth && !reduceMotion ? "smooth" : "auto"
    });
  }

  function readNextTrack() {
    const upcoming = Spicetify.Queue?.nextTracks;
    if (!Array.isArray(upcoming)) return null;
    for (const entry of upcoming) {
      const item = entry?.contextTrack || entry;
      const uri = typeof item?.uri === "string" ? item.uri : "";
      if (!uri || uri.includes("delimiter")) continue;
      const title = safeText(item.metadata?.title || item.name, "");
      if (title) return { title, artist: safeText(item.metadata?.artist_name || "", "") };
    }
    return null;
  }

  function renderNextTrack() {
    const win = state.pipWindow;
    if (!win || win.closed) return;
    const chip = win.document.getElementById("next-chip");
    const name = win.document.getElementById("next-name");
    if (!chip || !name) return;
    let next = null;
    try { next = readNextTrack(); } catch (_) { next = null; }
    chip.hidden = !next;
    const label = next ? next.title : "";
    if (name.textContent !== label) name.textContent = label;
    chip.title = next ? [next.title, next.artist].filter(Boolean).join(" — ") : "";
  }

  function renderProgress() {
    const win = state.pipWindow;
    if (!win || win.closed) return;
    const doc = win.document;
    const position = Math.max(0, state.positionMs);
    const duration = Math.max(0, state.durationMs);
    const percent = duration > 0 ? Math.max(0, Math.min(100, (position / duration) * 100)) : 0;
    doc.getElementById("progress-fill").style.width = `${percent}%`;
    doc.getElementById("elapsed").textContent = formatTime(position);
    doc.getElementById("duration").textContent = formatTime(duration);
    doc.getElementById("island").classList.toggle("is-playing", state.isPlaying);
    doc.getElementById("play-toggle").setAttribute("aria-label", state.isPlaying ? "Pause" : "Play");
    renderPlaybackIcon(doc, state.isPlaying);
  }

  function renderPlaybackIcon(doc, isPlaying) {
    const button = doc.getElementById("play-toggle");
    if (button) button.dataset.playing = String(Boolean(isPlaying));
  }

  function readPlaybackState() {
    const currentState = Player.data;
    if (typeof state.playbackEventOverride === "boolean") {
      if (typeof currentState?.is_playing === "boolean" && currentState.is_playing === state.playbackEventOverride) {
        state.playbackEventOverride = null;
        return currentState.is_playing;
      }
      const apiState = Player.isPlaying?.();
      if (apiState === state.playbackEventOverride) {
        state.playbackEventOverride = null;
        return apiState;
      }
      // The player snapshot can lag behind onplaypause. A newer timestamp alone
      // does not prove its is_playing value is newer, so keep the event state
      // until the API agrees or another playback event arrives.
      return state.playbackEventOverride;
    }

    const apiState = Player.isPlaying?.();
    // isPlaying() is the live player query; Player.data may be a cached snapshot.
    if (typeof apiState === "boolean") return apiState;
    return typeof currentState?.is_playing === "boolean" ? currentState.is_playing : null;
  }

  function syncPlaybackFromEvent(event) {
    // onplaypause is emitted for the actual transition. Trust its explicit
    // playback flag instead of rejecting it against potentially stale clocks.
    const eventState = event?.data || event || {};
    const eventIsPlaying = typeof eventState.is_playing === "boolean"
      ? eventState.is_playing
      : typeof eventState.is_paused === "boolean"
        ? !eventState.is_paused
        : null;

    if (typeof eventIsPlaying === "boolean") {
      state.playbackEventOverride = eventIsPlaying;
      state.isPlaying = eventIsPlaying;
      state.playbackAnchor = performance.now();
      renderProgress();
      if (!state.isPlaying) cancelWipeAnimation();
      return;
    }

    const currentPlaying = readPlaybackState();
    if (typeof currentPlaying === "boolean") {
      state.isPlaying = currentPlaying;
      state.playbackAnchor = performance.now();
      renderProgress();
      if (!state.isPlaying) cancelWipeAnimation();
    }
  }

  // Each renderer is isolated: a UI error must not reach the lyric request's
  // catch handler, which would otherwise discard lyrics that did arrive.
  function renderAll() {
    for (const render of [renderLyricMode, renderProgress, renderNextTrack]) {
      try { render(); } catch (error) {
        console.error(`[Popliyric] ${render.name} failed:`, error);
      }
    }
  }

  function requestTrackLyrics(uri) {
    if (state.lyricsRequestInFlight) return;
    if (!uri) {
      state.lyricsStatus = "missing";
      state.lyrics = [];
      renderAll();
      return;
    }
    const requestVersion = ++state.requestVersion;
    state.lastLyricsAttemptAt = Date.now();
    state.lyricsRequestInFlight = true;
    state.lyrics = [];
    state.lyricsSynced = false;
    state.lyricsStatus = "loading";
    renderAll();
    console.info("[Popliyric] Requesting track lyrics.");

    fetchLyrics(uri).then((result) => {
      if (requestVersion !== state.requestVersion || uri !== state.trackUri) return;
      state.lyricsRequestInFlight = false;
      state.lyrics = result.lines;
      state.lyricsSynced = result.synced;
      state.lyricsStatus = result.lines.length ? "available" : "missing";
      console.info("[Popliyric] Lyrics response received:", { lineCount: result.lines.length, synchronized: result.synced });
      renderAll();
    }).catch((error) => {
      if (requestVersion !== state.requestVersion || uri !== state.trackUri) return;
      state.lyricsRequestInFlight = false;
      console.warn("[Popliyric] Lyrics request failed:", error?.message || error);
      state.lyrics = [];
      state.lyricsSynced = false;
      state.lyricsStatus = "missing";
      renderAll();
    });
  }

  function clearTrackState() {
    state.track = null;
    state.trackKey = "";
    state.trackUri = "";
    state.lyrics = [];
    state.lyricsSynced = false;
    state.lyricsStatus = "missing";
    state.lyricsRequestInFlight = false;
    state.requestVersion += 1;
    state.activeIndex = -1;
    state.positionMs = 0;
    state.durationMs = 0;
    state.artworkUrl = "";
    state.emptyTrackSince = 0;
    state.emptyTrackSamples = 0;
    cancelWipeAnimation();
    setArtwork("");
  }

  function mergeTrack(current, incoming) {
    return {
      uri: incoming.uri || current?.uri || "",
      title: incoming.title || current?.title || "",
      artist: incoming.artist || current?.artist || "",
      album: incoming.album || current?.album || "",
      artwork: incoming.artwork || current?.artwork || ""
    };
  }

  function updateFromPlayer() {
    if (!state.pipWindow || state.pipWindow.closed) return;
    const nextPosition = Number(Player.getProgress?.());
    const nextDuration = Number(Player.getDuration?.());
    const nextIsPlaying = readPlaybackState();
    const track = readTrack();
    let trackIdentityChanged = false;

    if (track) {
      state.emptyTrackSince = 0;
      state.emptyTrackSamples = 0;
      const changed = state.track ? !sameTrack(state.track, track) : true;
      const previousUri = state.trackUri;
      state.track = changed ? track : mergeTrack(state.track, track);
      state.trackKey = state.track.uri || `${state.track.title}\u0000${state.track.artist}`;
      state.trackUri = state.track.uri || "";
      trackIdentityChanged = changed || state.trackUri !== previousUri;

      if (trackIdentityChanged) {
        state.positionMs = 0;
        state.durationMs = 0;
        state.lyrics = [];
        state.lyricsSynced = false;
        state.lyricsStatus = state.trackUri ? "loading" : "missing";
        state.activeIndex = -1;
        state.lyricsRequestInFlight = false;
        state.requestVersion += 1;
        cancelWipeAnimation();
        if (state.trackUri) requestTrackLyrics(state.trackUri);
      }

      // A missing image in a partial playback snapshot must not clear the visible artwork.
      if (state.track.artwork && state.track.artwork !== state.artworkUrl) {
        setArtwork(state.track.artwork);
      }
    } else {
      const playerState = Player.data;
      const queueTrack = Spicetify.Queue?.track;
      const noTrackEvidence = playerState != null && playerState.is_playing === false &&
        playerState.is_paused === false && Number(playerState.duration) === 0 &&
        !playerState.item?.uri && !playerState.track?.uri && !queueTrack?.uri &&
        nextIsPlaying !== true && !(Number.isFinite(nextDuration) && nextDuration > 0) &&
        !(Number.isFinite(nextPosition) && nextPosition > 0);
      if (noTrackEvidence) {
        if (!state.emptyTrackSince) state.emptyTrackSince = Date.now();
        state.emptyTrackSamples += 1;
        if (state.track && state.emptyTrackSamples >= 3 && Date.now() - state.emptyTrackSince >= 2_000) {
          clearTrackState();
        }
      } else {
        state.emptyTrackSince = 0;
        state.emptyTrackSamples = 0;
      }
    }

    if (Number.isFinite(nextPosition) && nextPosition >= 0 && (nextPosition > 0 || state.positionMs === 0)) {
      state.positionMs = nextPosition;
    }
    if (Number.isFinite(nextDuration) && nextDuration > 0) state.durationMs = nextDuration;
    else if (!state.track) state.durationMs = 0;
    if (typeof nextIsPlaying === "boolean") state.isPlaying = nextIsPlaying;
    state.playbackAnchor = performance.now();

    if (state.trackUri && state.lyricsStatus === "missing" && Date.now() - state.lastLyricsAttemptAt >= LYRICS_RETRY_MS) {
      requestTrackLyrics(state.trackUri);
    }
    renderAll();
    if (!state.isPlaying) cancelWipeAnimation();
  }

  // resizeTo() sets the outer size; add the window frame so the page area
  // (innerWidth/innerHeight) matches the layout size exactly.
  function resizeToInner(win, size) {
    const frameWidth = Math.max(0, (win.outerWidth || 0) - win.innerWidth);
    const frameHeight = Math.max(0, (win.outerHeight || 0) - win.innerHeight);
    win.resizeTo(size.width + frameWidth, size.height + frameHeight);
  }

  // Document PiP cannot disable manual resizing, so the window snaps back to
  // the size of the current view shortly after the user stops resizing it.
  function lockWindowSize(win) {
    let timer = 0;
    let streak = 0;
    let lastAttempt = 0;
    win.addEventListener("resize", () => {
      win.clearTimeout(timer);
      timer = win.setTimeout(() => {
        if (state.pipWindow !== win || win.closed) return;
        const target = state.expanded ? EXPANDED_SIZE : PILL_SIZE;
        if (Math.abs(win.innerWidth - target.width) <= 2 && Math.abs(win.innerHeight - target.height) <= 2) {
          streak = 0;
          return;
        }
        // Give up after a few quick retries if Spotify refuses or clamps the size.
        const now = performance.now();
        streak = now - lastAttempt < 1500 ? streak + 1 : 1;
        lastAttempt = now;
        if (streak > 3) return;
        try { resizeToInner(win, target); } catch (_) {}
      }, 220);
    });
  }

  function setExpanded(expanded, resize = true) {
    state.expanded = expanded;
    const win = state.pipWindow;
    if (!win || win.closed) return;
    const island = win.document.getElementById("island");
    island.classList.toggle("expanded", expanded);
    for (const button of win.document.querySelectorAll("[data-action='toggle-view']")) {
      button.setAttribute("aria-expanded", String(expanded));
    }
    if (resize && typeof win.resizeTo === "function") {
      const requested = expanded ? EXPANDED_SIZE : PILL_SIZE;
      try {
        resizeToInner(win, requested);
        window.setTimeout(() => {
          if (state.pipWindow !== win || win.closed || !win.innerHeight) return;
          if (expanded) scrollActiveLine(false);
          if (Math.abs(win.innerHeight - requested.height) > 48 || Math.abs(win.innerWidth - requested.width) > 48) {
            console.warn("[Popliyric] Spotify did not apply the requested PiP size.", {
              requested,
              actual: { width: win.innerWidth, height: win.innerHeight }
            });
            Spicetify.showNotification("Spotify blocked PiP resizing. Resize the PiP window manually, then click the arrow again.", true);
          }
        }, 350);
      } catch (error) {
        console.warn("[Popliyric] PiP resize was blocked:", error?.message || error);
        Spicetify.showNotification("Spotify blocked PiP resizing. Resize the PiP window manually, then click the arrow again.", true);
      }
    } else if (resize) {
      console.warn("[Popliyric] This PiP window does not expose resizeTo().");
    }
    if (expanded) win.requestAnimationFrame(() => scrollActiveLine(false));
  }

  function buildPipDocument(doc) {
    doc.title = "Popliyric";
    doc.documentElement.innerHTML = `
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width,initial-scale=1">
        <title>Popliyric</title>
        <style>
          @property --accent { syntax: "<color>"; inherits: true; initial-value: #7c8493; }
          @property --c1 { syntax: "<color>"; inherits: true; initial-value: #46535c; }
          @property --c2 { syntax: "<color>"; inherits: true; initial-value: #2f3d47; }
          @property --c3 { syntax: "<color>"; inherits: true; initial-value: #1f2a32; }
          :root { color-scheme: dark; font-family: Inter, "Segoe UI", sans-serif; }
          * { box-sizing: border-box; }
          html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; background: #0b0d10; color: #fff; }
          body { padding: 0; font-family: Inter, "Segoe UI", sans-serif; }
          button { font: inherit; }

          /* Shell: fills the whole PiP window, because a Document PiP window is an
             opaque rectangle and a rounded shape inside it leaves dark corners.
             The max size keeps the layout from stretching while the window is
             being resized; the window then snaps back to its fixed size. */
          #island { --accent: ${DEFAULT_ACCENT}; --surface: ${DEFAULT_SURFACE}; position: relative; isolation: isolate; width: 100%; height: 100%; max-width: ${PILL_SIZE.width}px; max-height: ${PILL_SIZE.height}px; overflow: hidden; color: #fff; background-color: var(--surface); background-image: linear-gradient(90deg, var(--c1), var(--c2) 48%, var(--c3)); box-shadow: inset 0 1px #ffffff1f; transition: --accent .55s, --c1 .55s, --c2 .55s, --c3 .55s; }

          /* Shared artwork frame with a neutral placeholder underneath the image. */
          .art-frame { position: relative; display: flex; align-items: center; justify-content: center; overflow: hidden; background: linear-gradient(135deg, #2c3a44, #1a232b); }
          .art-frame img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; color: transparent; font-size: 0; transition: opacity .2s; }
          .art-placeholder { width: 28px; height: 28px; fill: none; stroke: #9fb0ba; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }
          img[data-artwork]:not([src]), img[data-artwork].image-error { visibility: hidden; }

          /* Vinyl: grooved disc whose label shows the artwork; spins while playing. */
          .vinyl { position: absolute; border-radius: 50%; background: conic-gradient(from 25deg, transparent 0deg, #ffffff2b 45deg, transparent 85deg), repeating-radial-gradient(circle, #1a1b1d 0, #08090a 1px, #232528 2px, #08090a 3px); box-shadow: 0 2px 10px #0009; animation: vinyl-spin 5s linear infinite; animation-play-state: paused; }
          #island.is-playing .vinyl { animation-play-state: running; }
          .vinyl-label { position: absolute; left: 31.67%; top: 31.67%; width: 36.67%; height: 36.67%; overflow: hidden; border-radius: 50%; background: linear-gradient(135deg, #2c3a44, #1a232b); }
          .vinyl-label img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; transition: opacity .2s; }
          @keyframes vinyl-spin { to { transform: rotate(360deg); } }

          .collapsed-view { position: absolute; inset: 0; cursor: grab; user-select: none; animation: fade-in .2s ease; }
          @keyframes fade-in { from { opacity: 0; } }
          .collapsed-view:active { cursor: grabbing; }
          /* Compact player: 390 x 82; artwork is as tall as the window. */
          .pill-cover { position: absolute; z-index: 2; left: 0; top: 0; width: 82px; height: 82px; box-shadow: 5px 0 12px #0006; }
          .vinyl-pill { z-index: 1; left: 50px; top: 7px; width: 68px; height: 68px; }
          .collapsed-copy { position: absolute; left: 130px; right: 56px; top: 0; bottom: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; min-width: 0; text-align: center; }
          .lyric-preview { width: 100%; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; font-size: 16px; font-weight: 600; line-height: 1.3; letter-spacing: -.1px; white-space: normal; overflow-wrap: break-word; background-image: linear-gradient(to bottom, #fff 0%, #fff var(--lyric-progress, 0%), #cbd8de var(--lyric-progress, 0%), #cbd8de 100%); background-clip: text; -webkit-background-clip: text; color: transparent; -webkit-text-fill-color: transparent; }
          .lyric-preview.static-highlight { color: #fff; background: none; -webkit-text-fill-color: currentColor; }
          .fallback-copy { display: none; width: 100%; min-width: 0; }
          #island[data-mode="track-info"] .fallback-copy { display: block; }
          #island[data-mode="track-info"] .lyric-preview { display: none; }
          .fallback-title, .fallback-secondary { display: block; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
          .fallback-title { font-size: 16px; font-weight: 600; line-height: 1.3; }
          .fallback-secondary { margin-top: 2px; color: #d3e0e6; font-size: 13px; line-height: 1.3; }
          .collapsed-view .island-button { position: absolute; right: 12px; top: 24px; }

          .island-button { width: 34px; height: 34px; flex: none; display: inline-flex; align-items: center; justify-content: center; padding: 0; border: 0; border-radius: 50%; color: #fff; background: transparent; cursor: pointer; transition: background .16s, transform .16s; }
          .island-button:hover { background: #ffffff24; }
          .island-button:active { transform: scale(.92); }
          .island-button:focus-visible, .control-button:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
          .island-button svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
          /* Expanded card (layout B): fills the 460 x 352 window. */
          #island.expanded { max-width: ${EXPANDED_SIZE.width}px; max-height: ${EXPANDED_SIZE.height}px; background-color: #0b1218; background-image: none; }
          #island.expanded .collapsed-view { display: none; }

          /* Fake glass: blurred artwork + dark shade behind semi-transparent panels.
             It does not depend on backdrop-filter, which is only added as an enhancement. */
          .card-backdrop { position: absolute; inset: 0; z-index: 0; display: none; overflow: hidden; border-radius: inherit; background: linear-gradient(150deg, var(--c1), var(--c2) 55%, var(--c3)); }
          #island.expanded .card-backdrop { display: block; }
          .card-backdrop img { position: absolute; left: -60px; top: -60px; width: calc(100% + 120px); height: calc(100% + 120px); object-fit: cover; filter: blur(38px) saturate(1.5); opacity: .95; transform: translateZ(0); }
          .card-backdrop::after { content: ""; position: absolute; inset: 0; background: linear-gradient(180deg, #05080b66, #05080ba6); }
          .glass { background: linear-gradient(135deg, #ffffff2e, #ffffff0f); border: 1px solid #ffffff40; box-shadow: inset 0 1px #ffffff26, 0 6px 20px #0004; }
          @supports ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) { .glass { -webkit-backdrop-filter: blur(14px); backdrop-filter: blur(14px); } }

          .expanded-view { position: relative; z-index: 1; width: 100%; height: 100%; padding: 18px; display: none; flex-direction: column; justify-content: space-between; opacity: 0; cursor: grab; user-select: none; }
          .expanded-view:active { cursor: grabbing; }
          #island.expanded .expanded-view { display: flex; animation: reveal .2s ease forwards; }
          @keyframes reveal { to { opacity: 1; } }
          .row-top { display: flex; gap: 16px; height: 196px; min-height: 0; }
          .left-col { width: 150px; flex: none; display: flex; flex-direction: column; gap: 10px; }
          .large-cover { width: 150px; height: 150px; flex: none; border-radius: 18px; box-shadow: 0 10px 24px #0008; }
          .next-chip { height: 36px; min-width: 0; display: flex; align-items: center; gap: 6px; padding: 0 10px 0 12px; border-radius: 999px; }
          .next-tag { flex: none; color: #bfeaff; font-size: 10px; font-weight: 700; letter-spacing: .08em; }
          .next-name { flex: 1; min-width: 0; overflow: hidden; font-size: 12px; font-weight: 600; white-space: nowrap; text-overflow: ellipsis; }
          .next-chip svg { flex: none; width: 14px; height: 14px; fill: none; stroke: #fff; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }

          .lyrics-card { position: relative; flex: 1; min-width: 0; display: flex; flex-direction: column; padding: 10px 14px; border-radius: 22px; }
          .lyrics-head { position: absolute; z-index: 2; top: 6px; right: 6px; }
          .lyrics-head .island-button { width: 30px; height: 30px; }
          .lyrics-scroll { position: relative; flex: 1; min-height: 0; overflow-y: auto; cursor: auto; user-select: text; scrollbar-width: none; -webkit-mask-image: linear-gradient(transparent, #000 18%, #000 82%, transparent); mask-image: linear-gradient(transparent, #000 18%, #000 82%, transparent); }
          .lyrics-scroll::-webkit-scrollbar { display: none; }
          #lyrics-list { display: flex; flex-direction: column; gap: 7px; padding: 64px 22px 64px 0; }
          .lyric-line { position: relative; flex: none; padding-left: 12px; color: #cfdde4; font-size: 13px; line-height: 1.35; overflow-wrap: break-word; }
          #lyrics-list.unsynced .lyric-line { color: #eef4f7; }
          .lyric-line.active { font-size: 15px; font-weight: 700; line-height: 1.3; background-image: linear-gradient(to bottom, #fff 0%, #fff var(--lyric-progress, 0%), #cbd8de var(--lyric-progress, 0%), #cbd8de 100%); background-clip: text; -webkit-background-clip: text; color: transparent; -webkit-text-fill-color: transparent; }
          .lyric-line.active.static-highlight { color: #fff; background: none; -webkit-text-fill-color: currentColor; }
          .lyric-line.active::before { content: ""; position: absolute; left: 0; top: 1px; bottom: 1px; width: 3px; border-radius: 2px; background: #6fdcff; }
          .state-message { flex: 1; display: flex; align-items: center; justify-content: center; color: #d3e0e6; font-size: 13px; text-align: center; }
          .track-fallback { flex: 1; min-height: 0; display: flex; flex-direction: column; justify-content: center; gap: 6px; }
          .fallback-label { color: #bfeaff; font-size: 10px; font-weight: 700; letter-spacing: .08em; }
          #fallback-album { color: #d3e0e6; font-size: 13px; line-height: 1.35; overflow-wrap: break-word; }

          .now-bar { flex: none; height: 90px; display: flex; flex-direction: column; justify-content: space-between; padding: 10px 16px 12px; border-radius: 24px; }
          .bar-top { display: flex; align-items: center; gap: 12px; }
          .now-meta { flex: 1; min-width: 0; }
          .track-title, .track-artist { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
          .track-title { font-size: 14px; font-weight: 700; line-height: 1.3; }
          .track-artist { margin-top: 1px; color: #d3e0e6; font-size: 12px; line-height: 1.3; }
          .controls { flex: none; display: flex; align-items: center; gap: 6px; }
          .control-button { width: 36px; height: 36px; display: inline-flex; align-items: center; justify-content: center; padding: 0; border: 0; border-radius: 50%; color: #fff; background: transparent; cursor: pointer; transition: background .15s, transform .15s; }
          .control-button:hover { background: #ffffff24; }
          .control-button:active { transform: scale(.92); }
          .control-button svg { width: 20px; height: 20px; fill: currentColor; }
          .control-button.play-toggle { width: 40px; height: 40px; background: #ffffff2e; }
          .control-button.play-toggle:hover { background: #ffffff42; }
          .control-button.play-toggle svg { width: 22px; height: 22px; }
          .play-toggle .pause-icon, .play-toggle[data-playing="true"] .play-icon { display: none; }
          .play-toggle[data-playing="true"] .pause-icon { display: block; }
          .bar-collapse { display: none; }
          .progress-row { display: flex; align-items: center; gap: 8px; color: #d3e0e6; font-size: 10px; font-variant-numeric: tabular-nums; }
          .progress-track { flex: 1; height: 3px; overflow: hidden; border-radius: 999px; background: #ffffff40; }
          #progress-fill { display: block; width: 0; height: 100%; border-radius: inherit; background: #fff; transition: width .12s linear; }
          [hidden] { display: none !important; }

          /* If Spotify refuses the resize, keep the expanded card usable in a smaller window. */
          @media (max-width: 420px) { #island.expanded .left-col { display: none; } }
          @media (max-height: 300px) { #island.expanded .row-top { display: none; } #island.expanded .expanded-view { padding: 6px; justify-content: center; } #island.expanded .now-bar { height: auto; gap: 6px; padding: 6px 12px; } #island.expanded .bar-collapse { display: inline-flex; } }
          @media (max-height: 130px) { #island.expanded .progress-row { display: none; } }
          @media (prefers-reduced-motion: reduce) { *, *::before, *::after { scroll-behavior: auto !important; animation-duration: .01ms !important; transition-duration: .01ms !important; } .vinyl { animation: none !important; } }
        </style>
      </head>
      <body>
        <main id="island" data-mode="lyrics" aria-label="Popliyric player">
          <section id="collapsed-view" class="collapsed-view" title="Drag to move">
            <span class="vinyl vinyl-pill" aria-hidden="true"><span class="vinyl-label"><img id="small-label" data-artwork alt=""></span></span>
            <span class="art-frame pill-cover">${ART_PLACEHOLDER}<img id="small-cover" data-artwork alt="Album artwork"></span>
            <div class="collapsed-copy">
              <div id="small-primary" class="lyric-preview">Loading lyrics…</div>
              <div class="fallback-copy"><span id="small-title" class="fallback-title">Loading track…</span><span id="small-secondary" class="fallback-secondary"></span></div>
            </div>
            <button type="button" class="island-button" data-action="toggle-view" data-expanded="false" aria-label="Expand lyrics" title="Expand lyrics"><svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M3.25 6L8 10.75 12.75 6" /></svg></button>
          </section>
          <div class="card-backdrop" aria-hidden="true"><img id="backdrop-art" data-artwork alt=""></div>
          <section id="expanded-view" class="expanded-view" aria-label="Expanded player">
            <div class="row-top">
              <div class="left-col">
                <span class="art-frame large-cover">${ART_PLACEHOLDER}<img id="large-cover" data-artwork alt="Album artwork"></span>
                <div id="next-chip" class="next-chip glass" hidden><span class="next-tag">NEXT</span><span id="next-name" class="next-name"></span><svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M6 3.25L10.75 8 6 12.75" /></svg></div>
              </div>
              <section class="lyrics-card glass" aria-label="Lyrics">
                <div class="lyrics-head">${COLLAPSE_BUTTON("")}</div>
                <div id="lyrics-loading" class="state-message">Loading lyrics…</div>
                <div id="lyrics-panel" class="lyrics-scroll"><div id="lyrics-list"></div></div>
                <div id="track-fallback" class="track-fallback" hidden><div class="fallback-label">NO LYRICS FOR THIS TRACK</div><div id="fallback-album"></div></div>
              </section>
            </div>
            <footer class="now-bar glass">
              <div class="bar-top">
                <div class="now-meta"><div id="track-title" class="track-title">Loading track…</div><div id="track-artist" class="track-artist"></div></div>
                <nav class="controls" aria-label="Playback controls">
                  <button type="button" class="control-button" data-action="previous" aria-label="Previous track"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M6 5h2v14H6zM20 5v14L9.5 12z" /></svg></button>
                  <button type="button" id="play-toggle" class="control-button play-toggle" data-playing="false" data-action="toggle" aria-label="Play"><svg class="play-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M8 4.5v15L19.5 12z" /></svg><svg class="pause-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M7 4h4v16H7zM13 4h4v16h-4z" /></svg></button>
                  <button type="button" class="control-button" data-action="next" aria-label="Next track"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M16 5h2v14h-2zM4 5v14l10.5-7z" /></svg></button>
                </nav>
                ${COLLAPSE_BUTTON("bar-collapse")}
              </div>
              <div class="progress-row" aria-label="Playback progress"><span id="elapsed">0:00</span><div class="progress-track"><span id="progress-fill"></span></div><span id="duration">0:00</span></div>
            </footer>
          </section>
        </main>
      </body>`;

    const docWindow = state.pipWindow;
    const island = doc.getElementById("island");
    const supportsBackdrop = Boolean(docWindow.CSS?.supports?.("backdrop-filter", "blur(1px)") ||
      docWindow.CSS?.supports?.("-webkit-backdrop-filter", "blur(1px)"));
    console.info("[Popliyric] backdrop-filter supported in PiP:", supportsBackdrop, "(the glass look does not depend on it)");
    lockWindowSize(docWindow);
    // The window resize after expanding is asynchronous; centre the active line
    // once the lyrics panel actually has a height.
    if (typeof docWindow.ResizeObserver === "function") {
      new docWindow.ResizeObserver(() => {
        if (state.expanded) scrollActiveLine(false);
      }).observe(doc.getElementById("lyrics-panel"));
    }
    let dragStart = null;

    // Dragging moves the window; only the chevron buttons expand or collapse it.
    function makeDragHandle(element) {
      element.addEventListener("pointerdown", (event) => {
        // Buttons stay clickable and the lyrics list stays scrollable/selectable.
        if (event.button !== 0 || event.target.closest("button, .lyrics-scroll")) return;
        dragStart = { pointerId: event.pointerId, x: event.screenX, y: event.screenY, moved: false };
        element.setPointerCapture(event.pointerId);
      });
      element.addEventListener("pointermove", (event) => {
        if (!dragStart || dragStart.pointerId !== event.pointerId) return;
        const dx = event.screenX - dragStart.x;
        const dy = event.screenY - dragStart.y;
        if (!dragStart.moved && Math.hypot(dx, dy) < 4) return;
        dragStart.moved = true;
        dragStart.x = event.screenX;
        dragStart.y = event.screenY;
        try { docWindow.moveBy(dx, dy); } catch (_) {
          /* Document PiP implementations may not allow page-controlled movement. */
        }
      });
      const endDrag = (event) => {
        if (dragStart?.pointerId !== event.pointerId) return;
        dragStart = null;
      };
      element.addEventListener("pointerup", endDrag);
      element.addEventListener("pointercancel", endDrag);
    }

    makeDragHandle(doc.getElementById("collapsed-view"));
    makeDragHandle(doc.getElementById("expanded-view"));
    doc.querySelectorAll("[data-action='toggle-view']").forEach((button) => {
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        setExpanded(button.dataset.expanded !== "true");
      });
    });
    doc.querySelectorAll("[data-action]").forEach((button) => {
      button.addEventListener("click", (event) => {
        const action = button.dataset.action;
        if (action === "toggle-view") return;
        event.stopPropagation();
        if (action === "previous") Player.back();
        else if (action === "next") Player.next();
        else if (action === "toggle") Player.togglePlay();
      });
    });
    island.classList.toggle("expanded", state.expanded);
    docWindow.addEventListener("pagehide", () => {
      if (state.pipWindow !== docWindow) return;
      if (state.refreshTimer) clearInterval(state.refreshTimer);
      state.refreshTimer = 0;
      cancelWipeAnimation();
      state.pipWindow = null;
      state.expanded = false;
    }, { once: true });
  }

  function openPictureInPicture() {
    const activePip = state.pipWindow && !state.pipWindow.closed
      ? state.pipWindow
      : window.documentPictureInPicture?.window;
    if (activePip && !activePip.closed) {
      activePip.close();
      if (state.refreshTimer) clearInterval(state.refreshTimer);
      state.refreshTimer = 0;
      cancelWipeAnimation();
      if (state.pipWindow === activePip) state.pipWindow = null;
      return;
    }
    if (state.pipOpening) return;
    if (!("documentPictureInPicture" in window)) {
      Spicetify.showNotification("Document Picture-in-Picture is unavailable in this Spotify version.", true);
      return;
    }
    state.pipOpening = true;
    window.documentPictureInPicture.requestWindow({ ...PILL_SIZE }).then((pipWindow) => {
      state.pipWindow = pipWindow;
      state.expanded = false;
      buildPipDocument(pipWindow.document);
      updateFromPlayer();
      if (!state.refreshTimer) state.refreshTimer = window.setInterval(updateFromPlayer, REFRESH_MS);
    }).catch((error) => {
      state.pipWindow = null;
      console.warn("[Popliyric] Could not open the PiP window:", error?.message || error);
      Spicetify.showNotification("Could not open the Popliyric window.", true);
    }).finally(() => { state.pipOpening = false; });
  }

  new Spicetify.Topbar.Button("Popliyric", `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1 9h2V7H1zm3 3h2V4H4zm3-2h2V6H7zm3 2h2V4h-2zm3-3h2V7h-2z" fill="currentColor"/></svg>`, openPictureInPicture);
  Player.addEventListener?.("songchange", updateFromPlayer);
  Player.addEventListener?.("onplaypause", syncPlaybackFromEvent);
  Player.addEventListener?.("onprogress", updateFromPlayer);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) updateFromPlayer();
  });
  window.addEventListener("pageshow", updateFromPlayer);
})();
