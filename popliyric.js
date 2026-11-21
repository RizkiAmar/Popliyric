(async function PopliyricExtension() {
  const LYRICS_HOST = "https://spclient.wg.spotify.com/color-lyrics/v2";
  const DEFAULT_ACCENT = "#7c8493";
  const DEFAULT_SURFACE = "#17191f";
  const DEFAULT_PALETTE = ["#46535c", "#2f3d47", "#1f2a32"];
  const ART_PLACEHOLDER = `<svg class="art-placeholder" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M9 18V6l10-2v12"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="16.5" cy="16" r="2.5"/></svg>`;
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
      if (!token) return { lines: [], synced: false };
      const response = await fetch(`${LYRICS_HOST}/track/${encodeURIComponent(trackId)}?format=json&vocalRemoval=false&market=from_token`, {
        headers: {
          Authorization: `Bearer ${token}`,
          "App-Platform": platform.PlatformData?.app_platform || "Win32_x86_64",
          "Spotify-App-Version": platform.version
        }
      });
      if (!response.ok) return { lines: [], synced: false };
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
      doc.getElementById("track-album").textContent = track.album;
      doc.getElementById("small-title").textContent = track.title || "Loading track…";
      doc.getElementById("fallback-album").textContent = track.album;
    } else {
      doc.getElementById("small-primary").textContent = "No track playing";
      doc.getElementById("small-title").textContent = "No track playing";
      doc.getElementById("small-secondary").textContent = "";
      doc.getElementById("small-secondary").hidden = true;
      doc.getElementById("track-title").textContent = "No track playing";
      doc.getElementById("track-artist").textContent = "Play a song in Spotify";
      doc.getElementById("track-album").textContent = "";
      doc.getElementById("fallback-album").textContent = "";
    }

    const list = doc.getElementById("lyrics-list");
    if (!hasLyrics) {
      list.replaceChildren();
      state.activeIndex = -1;
      return;
    }
    if (list.dataset.uri !== state.trackUri) {
      list.dataset.uri = state.trackUri;
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
      if (active >= 0 && state.expanded) {
        list.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" });
      }
    }
    applyWipe();
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

  function renderAll() {
    renderLyricMode();
    renderProgress();
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

  function setExpanded(expanded, resize = true) {
    state.expanded = expanded;
    const win = state.pipWindow;
    if (!win || win.closed) return;
    const island = win.document.getElementById("island");
    island.classList.toggle("expanded", expanded);
    for (const button of win.document.querySelectorAll("[data-action='toggle-view']")) {
      button.setAttribute("aria-label", expanded ? "Collapse lyrics" : "Expand lyrics");
      button.title = expanded ? "Collapse lyrics" : "Expand lyrics";
      button.dataset.expanded = String(expanded);
    }
    if (resize && typeof win.resizeTo === "function") {
      const requestedHeight = expanded ? 420 : 82;
      try {
        win.resizeTo(390, requestedHeight);
        window.setTimeout(() => {
          if (state.pipWindow !== win || win.closed || !win.innerHeight) return;
          if (Math.abs(win.innerHeight - requestedHeight) > 48) {
            console.warn("[Popliyric] Spotify did not apply the requested PiP size.", {
              requestedHeight,
              actualHeight: win.innerHeight
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
    if (expanded) {
      const active = win.document.querySelector(`[data-index="${state.activeIndex}"]`);
      active?.scrollIntoView({ block: "center", behavior: "smooth" });
    }
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
          html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; background: transparent; color: #fff; }
          body { padding: 5px 6px; font-family: Inter, "Segoe UI", sans-serif; }
          button { font: inherit; }

          /* Shell: the pill background; the expanded card is styled further below. */
          #island { --accent: ${DEFAULT_ACCENT}; --surface: ${DEFAULT_SURFACE}; position: relative; isolation: isolate; width: 100%; height: 100%; border: 1px solid #ffffff3d; border-radius: 999px; color: #fff; background-color: var(--surface); background-image: linear-gradient(90deg, var(--c1), var(--c2) 48%, var(--c3)); box-shadow: 0 8px 28px #0007, inset 0 1px #ffffff2e; transition: --accent .55s, --c1 .55s, --c2 .55s, --c3 .55s, border-radius .22s, border-color .22s; }
          #island:hover { border-color: #ffffff5c; }

          /* Shared artwork frame with a neutral placeholder underneath the image. */
          .art-frame { position: relative; display: flex; align-items: center; justify-content: center; overflow: hidden; background: linear-gradient(135deg, #2c3a44, #1a232b); }
          .art-frame img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; color: transparent; font-size: 0; transition: opacity .2s; }
          .art-placeholder { width: 28px; height: 28px; fill: none; stroke: #9fb0ba; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }
          img[data-artwork]:not([src]), img[data-artwork].image-error { visibility: hidden; }

          /* Vinyl: grooved disc whose label shows the artwork; spins while playing. */
          .vinyl { position: absolute; border-radius: 50%; background: conic-gradient(from 25deg, transparent 0deg, #ffffff2b 45deg, transparent 85deg), repeating-radial-gradient(circle, #1a1b1d 0, #08090a 1px, #232528 2px, #08090a 3px); box-shadow: 0 2px 10px #0009; animation: vinyl-spin 5s linear infinite; animation-play-state: paused; }
          #island.is-playing .vinyl { animation-play-state: running; }
          .vinyl-label { position: absolute; left: 19px; top: 19px; width: 22px; height: 22px; overflow: hidden; border-radius: 50%; background: linear-gradient(135deg, #2c3a44, #1a232b); }
          .vinyl-label img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; transition: opacity .2s; }
          @keyframes vinyl-spin { to { transform: rotate(360deg); } }

          /* Compact pill: 378 x 72 inside the 390 x 82 window. */
          .collapsed-view { position: absolute; inset: -1px; cursor: grab; user-select: none; }
          .collapsed-view:active { cursor: grabbing; }
          .pill-cover { position: absolute; z-index: 2; left: 0; top: 0; width: 72px; height: 72px; border-radius: 6px; box-shadow: 5px 0 12px #0006; }
          .vinyl-pill { z-index: 1; left: 44px; top: 6px; width: 60px; height: 60px; }
          .collapsed-copy { position: absolute; left: 114px; right: 52px; top: 0; bottom: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; min-width: 0; text-align: center; }
          .lyric-preview { width: 100%; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; font-size: 14px; font-weight: 600; line-height: 1.35; letter-spacing: -.1px; white-space: normal; overflow-wrap: break-word; background-image: linear-gradient(to bottom, #fff 0%, #fff var(--lyric-progress, 0%), #cbd8de var(--lyric-progress, 0%), #cbd8de 100%); background-clip: text; -webkit-background-clip: text; color: transparent; -webkit-text-fill-color: transparent; }
          .lyric-preview.static-highlight { color: #fff; background: none; -webkit-text-fill-color: currentColor; }
          .fallback-copy { display: none; width: 100%; min-width: 0; }
          #island[data-mode="track-info"] .fallback-copy { display: block; }
          #island[data-mode="track-info"] .lyric-preview { display: none; }
          .fallback-title, .fallback-secondary { display: block; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
          .fallback-title { font-size: 14px; font-weight: 600; line-height: 1.3; }
          .fallback-secondary { margin-top: 2px; color: #d3e0e6; font-size: 12px; line-height: 1.3; }
          .collapsed-view .island-button { position: absolute; right: 10px; top: 19px; }

          .island-button { width: 34px; height: 34px; flex: none; display: inline-flex; align-items: center; justify-content: center; padding: 0; border: 0; border-radius: 50%; color: #fff; background: transparent; cursor: pointer; transition: background .16s, transform .16s; }
          .island-button:hover { background: #ffffff24; }
          .island-button:active { transform: scale(.92); }
          .island-button:focus-visible, .control-button:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
          .island-button svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
          #island.expanded { overflow: hidden; border-radius: 24px; }
          #island.expanded .collapsed-view { display: none; }
          .expanded-view { width: 100%; height: 100%; padding: 14px 17px 12px; display: none; flex-direction: column; gap: 9px; opacity: 0; }
          #island.expanded .expanded-view { display: flex; animation: reveal .2s ease forwards; }
          @keyframes reveal { to { opacity: 1; } }
          .track-header:active { cursor: grabbing; }
          .header-cover { width: 56px; height: 56px; flex: none; border-radius: 8px; }
          .island-button[data-expanded="true"] svg { transform: rotate(180deg); }
          .track-header { min-height: 62px; display: flex; align-items: center; gap: 12px; cursor: grab; user-select: none; }
          .track-info { flex: 1; min-width: 0; }
          .track-title { color: #f5f5f5; font-size: 14px; font-weight: 600; line-height: 1.3; white-space: normal; overflow-wrap: break-word; word-break: normal; max-height: 2.6em; overflow: hidden; }
          .track-artist { margin-top: 3px; color: #a1a1aa; font-size: 12px; font-weight: 400; line-height: 1.25; white-space: normal; overflow-wrap: break-word; word-break: normal; max-height: 1.25em; overflow: hidden; }
          .track-album { margin-top: 2px; color: #858995; font-size: 11px; line-height: 1.2; white-space: normal; overflow: hidden; }
          .lyrics-window { flex: 1; min-height: 88px; overflow: auto; padding: 9px 12px; border: 1px solid #ffffff0d; border-radius: 18px; background: #07080b65; scrollbar-width: thin; scrollbar-color: #ffffff32 transparent; text-align: center; }
          .lyrics-window[hidden], .state-message[hidden], .track-fallback[hidden] { display: none; }
          #lyrics-list { min-height: 100%; display: flex; flex-direction: column; justify-content: center; }
          .lyric-line { flex: 0 0 auto; width: 100%; max-height: 3em; overflow: hidden; padding: 4px 0; color: #9298a0; font-size: 13px; font-weight: 500; line-height: 1.5; text-align: center; white-space: normal; overflow-wrap: normal; word-break: normal; }
          .lyric-line.active { color: #fff; font-size: 15px; font-weight: 600; background-image: linear-gradient(to bottom,#fff 0%,#fff var(--lyric-progress,0%),#9298a0 var(--lyric-progress,0%),#9298a0 100%); background-clip: text; -webkit-background-clip: text; color: transparent; -webkit-text-fill-color: transparent; }
          .lyric-line.active.static-highlight { color: #fff; background: none; -webkit-text-fill-color: currentColor; }
          .state-message { padding: 16px 4px; color: #a1a1aa; font-size: 13px; line-height: 1.5; text-align: center; }
          .track-fallback { flex: 1; min-height: 88px; padding: 16px; display: flex; flex-direction: column; justify-content: center; border: 1px solid #ffffff0d; border-radius: 18px; background: #07080b65; }
          .fallback-label { color: #a1a1aa; font-size: 10px; font-weight: 600; letter-spacing: .1em; }
          #fallback-album { margin-top: 8px; color: #f5f5f5; font-size: 15px; font-weight: 600; line-height: 1.4; white-space: normal; overflow-wrap: break-word; }
          .progress-row { display: flex; align-items: center; gap: 8px; color: #9298a0; font-size: 10px; font-variant-numeric: tabular-nums; }
          .progress-track { flex: 1; height: 3px; overflow: hidden; border-radius: 999px; background: #ffffff28; }
          #progress-fill { display: block; width: 0; height: 100%; border-radius: inherit; background: #f5f5f5; transition: width .12s linear; }
          .controls { min-height: 34px; display: flex; align-items: center; justify-content: center; gap: 20px; }
          .control-button { width: 36px; height: 34px; display: inline-flex; align-items: center; justify-content: center; padding: 0; border: 0; border-radius: 50%; color: #e5e7eb; background: transparent; cursor: pointer; transition: color .15s, transform .15s; }
          .control-button:hover { color: #fff; }
          .control-button:active { transform: scale(.92); }
          .control-button svg { width: 19px; height: 19px; fill: currentColor; }
          .control-button.play-toggle svg { width: 21px; height: 21px; }
          .control-button.play-toggle .play-icon { display: block !important; }
          .control-button.play-toggle .pause-icon { display: none !important; }
          .control-button.play-toggle[data-playing="true"] .play-icon { display: none !important; }
          .control-button.play-toggle[data-playing="true"] .pause-icon { display: block !important; }
          .control-button.play-toggle svg.play-icon, .control-button.play-toggle svg.pause-icon { width: 21px !important; height: 21px !important; fill: #fff !important; color: #fff !important; opacity: 1 !important; visibility: visible !important; flex: 0 0 21px; }
          [hidden] { display: none !important; }
          @media (max-height: 280px) { #island.expanded .expanded-view { padding: 7px 10px; gap: 4px; } #island.expanded .track-header { min-height: 50px; } #island.expanded .vinyl-large { width: 46px; height: 46px; } #island.expanded .lyrics-window, #island.expanded .track-fallback { min-height: 48px; } #island.expanded .controls { min-height: 28px; } }
          @media (max-width: 310px) { .collapsed-view { gap: 7px; padding-inline: 7px; } .vinyl-small { width: 38px; height: 38px; } .track-header { gap: 7px; } .expanded-view { padding-inline: 10px; } }
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
          <section id="expanded-view" class="expanded-view" aria-label="Expanded player">
            <header id="track-header" class="track-header" title="Drag to move or click to collapse">
              <span class="art-frame header-cover">${ART_PLACEHOLDER}<img id="large-cover" data-artwork alt="Album artwork"></span>
              <div class="track-info"><div id="track-title" class="track-title">Loading track…</div><div id="track-artist" class="track-artist"></div><div id="track-album" class="track-album"></div></div>
              <button type="button" class="island-button" data-action="toggle-view" data-expanded="false" aria-label="Collapse lyrics" title="Collapse lyrics"><svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M3.25 6L8 10.75 12.75 6" /></svg></button>
            </header>
            <div id="lyrics-loading" class="state-message">Loading lyrics…</div>
            <section id="lyrics-panel" class="lyrics-window" aria-label="Lyrics"><div id="lyrics-list"></div></section>
            <section id="track-fallback" class="track-fallback" aria-label="Track information" hidden><div class="fallback-label">TRACK INFORMATION</div><div id="fallback-album"></div></section>
            <div class="progress-row" aria-label="Playback progress"><span id="elapsed">0:00</span><div class="progress-track"><span id="progress-fill"></span></div><span id="duration">0:00</span></div>
            <nav class="controls" aria-label="Playback controls">
              <button type="button" class="control-button" data-action="previous" aria-label="Previous track"><svg viewBox="0 0 18 18" aria-hidden="true"><path d="M2.5 2.5H5v13H2.5zM15.5 3v12L5.5 9z" /></svg></button>
              <button type="button" id="play-toggle" class="control-button play-toggle" data-playing="false" data-action="toggle" aria-label="Play"><svg id="play-icon" class="play-icon" width="21" height="21" viewBox="0 0 18 18" aria-hidden="true"><path d="M3.5 2.5v13L14.5 9z" /></svg><svg id="pause-icon" class="pause-icon" width="21" height="21" viewBox="0 0 18 18" aria-hidden="true"><path d="M4.5 2.5h3v13h-3zM10.5 2.5h3v13h-3z" /></svg></button>
              <button type="button" class="control-button" data-action="next" aria-label="Next track"><svg viewBox="0 0 18 18" aria-hidden="true"><path d="M13 2.5h2.5v13H13zM2.5 3v12l10-6z" /></svg></button>
            </nav>
          </section>
        </main>
      </body>`;

    const docWindow = state.pipWindow;
    const island = doc.getElementById("island");
    let dragStart = null;
    let suppressClickUntil = 0;

    function makeDragHandle(element, clickToggles) {
      element.addEventListener("pointerdown", (event) => {
        if (event.button !== 0 || event.target.closest("button")) return;
        dragStart = { pointerId: event.pointerId, x: event.screenX, y: event.screenY, moved: false };
        suppressClickUntil = 0;
        element.setPointerCapture(event.pointerId);
      });
      element.addEventListener("pointermove", (event) => {
        if (!dragStart || dragStart.pointerId !== event.pointerId) return;
        const dx = event.screenX - dragStart.x;
        const dy = event.screenY - dragStart.y;
        if (!dragStart.moved && Math.hypot(dx, dy) < 4) return;
        dragStart.moved = true;
        didDrag = true;
        dragStart.x = event.screenX;
        dragStart.y = event.screenY;
        try { docWindow.moveBy(dx, dy); } catch (_) {
          /* Document PiP implementations may not allow page-controlled movement. */
        }
      });
      const endDrag = (event) => {
        if (dragStart?.pointerId !== event.pointerId) return;
        if (dragStart.moved) suppressClickUntil = performance.now() + 300;
        dragStart = null;
      };
      element.addEventListener("pointerup", endDrag);
      element.addEventListener("pointercancel", endDrag);
      if (clickToggles) {
        element.addEventListener("click", () => {
          if (performance.now() < suppressClickUntil) { suppressClickUntil = 0; return; }
          setExpanded(!state.expanded);
        });
      }
    }

    makeDragHandle(doc.getElementById("collapsed-view"), true);
    makeDragHandle(doc.getElementById("track-header"), true);
    doc.querySelectorAll("[data-action='toggle-view']").forEach((button) => {
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        suppressClickUntil = 0;
        setExpanded(!state.expanded);
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
    window.documentPictureInPicture.requestWindow({ width: 390, height: 82 }).then((pipWindow) => {
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
