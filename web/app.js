import { FFmpeg } from "/vendor/ffmpeg/index.js";
import { t, applyTranslations, toggleLang } from "./i18n.js";

const SEGMENT_CONCURRENCY = 8;
const FASTSTART_MAX_INPUT_BYTES = 1_500_000_000;
const FFMPEG_EXEC_TIMEOUT_MS = 20 * 60 * 1000;
const SERVER_MUX_SEGMENT_THRESHOLD = 3_000;
let ffmpegWorkerURLPromise = null;

const KINESCOPE_BASE_URL = "https://kinescope.io";
const MANIFEST_URLS = [
  "https://kinescope.io/new-manifest/{video_id}/master.mpd",
  "https://kinescope.io/{video_id}/master.mpd",
];
const CLEARKEY_LICENSE_URL = "https://license.kinescope.io/v1/vod/{video_id}/acquire/clearkey?token=";
const FFMPEG_CORE_FALLBACK_BASE = "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm";
const FFMPEG_ASSET_VERSION = "20260504-2";

function versionedAssetUrl(path) {
  return `${window.location.origin}${path}?v=${FFMPEG_ASSET_VERSION}`;
}

const API_ENDPOINTS = {
  extract: "/api/extract",
  license: "/api/license",
  manifest: "/api/manifest",
  resolve: "/api/resolve",
  segment: "/api/segment",
  serverMux: "/api/server-mux",
  serverZip: "/api/server-zip",
  title: "/api/title",
};
const KINESCOPE_OEMBED_URL = "https://kinescope.io/oembed?url=https://kinescope.io/{video_id}";
const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{6,}$/;
const KINESCOPE_RESERVED_IDS = new Set(["embed", "oembed", "player", "new-manifest", "master", "master.mpd", "video"]);

const elements = {
  form: document.querySelector("#downloadForm"),
  sourceInput: document.querySelector("#sourceInput"),
  urlInput: document.querySelector("#urlInput"),
  pasteButton: document.querySelector("#pasteButton"),
  candidateSelect: document.querySelector("#candidateSelect"),
  candidateList: document.querySelector("#candidateList"),
  candidateCount: document.querySelector("#candidateCount"),
  chooseCard: document.querySelector("#chooseCard"),
  refererInput: document.querySelector("#refererInput"),
  filenameInput: document.querySelector("#filenameInput"),
  qualitySelect: document.querySelector("#qualitySelect"),
  qualityPills: document.querySelector("#qualityPills"),
  qualityCard: document.querySelector("#qualityCard"),
  qualityMeta: document.querySelector("#qualityMeta"),
  inspectButton: document.querySelector("#inspectButton"),
  downloadButton: document.querySelector("#downloadButton"),
  progressCard: document.querySelector("#progressCard"),
  progressFill: document.querySelector("#progressFill"),
  progressTrack: document.querySelector("#progressTrack"),
  stageText: document.querySelector("#stageText"),
  percentText: document.querySelector("#percentText"),
  steps: document.querySelector("#steps"),
  resultCard: document.querySelector("#resultCard"),
  hintLine: document.querySelector("#hintLine"),
  speedText: document.querySelector("#speedText"),
  etaText: document.querySelector("#etaText"),
  progressCurrent: document.querySelector("#progressCurrent"),
  resultTitle: document.querySelector("#resultTitle"),
  langToggle: document.querySelector("#langToggle"),
  runtimeStatus: document.querySelector("#runtimeStatus"),
  manifestProgress: document.querySelector("#manifestProgress"),
  manifestLabel: document.querySelector("#manifestLabel"),
  videoProgress: document.querySelector("#videoProgress"),
  videoLabel: document.querySelector("#videoLabel"),
  audioProgress: document.querySelector("#audioProgress"),
  audioLabel: document.querySelector("#audioLabel"),
  ffmpegProgress: document.querySelector("#ffmpegProgress"),
  ffmpegLabel: document.querySelector("#ffmpegLabel"),
  previewVideo: document.querySelector("#previewVideo"),
  downloadLink: document.querySelector("#downloadLink"),
  logOutput: document.querySelector("#logOutput"),
  videoIdValue: document.querySelector("#videoIdValue"),
  trackValue: document.querySelector("#trackValue"),
  encryptionValue: document.querySelector("#encryptionValue"),
};

const STAGE_WEIGHTS = { manifest: [0, 8], video: [8, 58], audio: [58, 78], ffmpeg: [78, 100] };
const STAGE_LABEL_KEYS = {
  manifest: "stage.find",
  video: "stage.download",
  audio: "stage.download",
  ffmpeg: "stage.combine",
  zip: "stage.downloadVideos",
};
const STAGE_TO_STEP = { manifest: "find", video: "download", audio: "download", ffmpeg: "combine", zip: "download" };
const STEP_ORDER = ["find", "download", "combine", "done"];
const overallStage = { manifest: 0, video: 0, audio: 0, ffmpeg: 0, zip: 0, current: "manifest" };
const speedTracker = { startTime: 0, bytes: 0, lastUpdate: 0, segmentsTotal: 0, segmentsDone: 0 };

const state = {
  archiveDownloadMode: false,
  audioTrack: null,
  busy: false,
  candidates: [],
  downloadUrl: null,
  encrypted: false,
  encryptionKid: "",
  ffmpeg: null,
  manifestUrl: "",
  qualityPref: "best",
  queueIndex: 0,
  queueProgressTotal: 0,
  queueTotal: 0,
  queueResults: [],
  selectedVideoIds: new Set(),
  serverDownloadActive: false,
  serverDownloadMode: false,
  thumbnail: "",
  title: "",
  videoId: "",
  videoTracks: [],
  metaCache: new Map(),
};

applyTranslations(document);
syncLayoutState();
elements.langToggle?.addEventListener("click", () => {
  toggleLang();
  updateDownloadButtonLabel();
});

const QUALITY_PRESETS = [
  { value: "best", label: "Best", height: Infinity },
  { value: "1080", label: "1080p", height: 1080 },
  { value: "720", label: "720p", height: 720 },
  { value: "480", label: "480p", height: 480 },
  { value: "360", label: "360p", height: 360 },
];

elements.inspectButton.addEventListener("click", () => {
  syncSourceFromUrl();
  runAction(inspectSource);
});

elements.form.addEventListener("submit", (event) => {
  event.preventDefault();
  syncSourceFromUrl();
  runAction(downloadSelectedVideos);
});

elements.qualitySelect.addEventListener("change", updateSelectedMetadata);

elements.candidateSelect.addEventListener("change", () => {
  runAction(inspectSelectedCandidate);
});

elements.pasteButton?.addEventListener("click", async () => {
  const text = await readClipboardSafe();
  if (!text) {
    setHint(t("err.clipboard"));
    return;
  }
  elements.urlInput.value = text;
  syncSourceFromUrl();
  runAction(inspectSource);
});

elements.urlInput?.addEventListener("focus", async () => {
  if (state.busy || elements.urlInput.value.trim()) return;
  const text = await readClipboardSafe();
  if (text && /kinescope|http|<|^[A-Za-z0-9_-]{6,}$/i.test(text)) {
    elements.urlInput.value = text;
    syncSourceFromUrl();
  }
});

elements.urlInput?.addEventListener("input", syncSourceFromUrl);

window.addEventListener("paste", (event) => {
  const target = event.target;
  const isEditable = target instanceof HTMLInputElement
    || target instanceof HTMLTextAreaElement
    || target?.isContentEditable;

  const html = event.clipboardData?.getData("text/html") || "";
  const text = event.clipboardData?.getData("text/plain") || "";
  const pasted = (html || text).trim();
  if (!pasted) return;

  if (isEditable && target !== elements.urlInput) return;

  event.preventDefault();
  elements.urlInput.value = pasted.length > 2000 ? pasted.slice(0, 2000) : pasted;
  elements.sourceInput.value = pasted;
  runAction(inspectSource);
});

window.addEventListener("DOMContentLoaded", async () => {
  if (!navigator.clipboard?.readText) return;
  const text = await readClipboardSafe();
  if (text && /kinescope|<iframe|<html/i.test(text)) {
    elements.urlInput.value = text.length > 2000 ? text.slice(0, 2000) : text;
    syncSourceFromUrl();
  }
});

function syncSourceFromUrl() {
  if (elements.urlInput) {
    elements.sourceInput.value = elements.urlInput.value;
  }
  syncLayoutState();
}

function syncLayoutState(forceActive = false) {
  const hasWork = state.candidates.length > 0
    || !elements.progressCard?.hidden
    || !elements.resultCard?.hidden;
  document.body.classList.toggle("is-active", forceActive || hasWork);
}

async function readClipboardSafe() {
  if (!navigator.clipboard?.readText) return "";
  try {
    return (await navigator.clipboard.readText()).trim();
  } catch {
    return "";
  }
}

function setHint(text) {
  if (elements.hintLine) elements.hintLine.textContent = text;
}

function runAction(action) {
  if (state.busy) {
    return;
  }

  action().catch((error) => {
    setRuntime("error", "error");
    log(error.message || String(error));
    if (elements.stageText) elements.stageText.textContent = error.message || t("stage.error");
    if (elements.progressCard) {
      elements.progressCard.hidden = false;
      elements.progressCard.classList.add("is-error");
    }
  }).finally(() => {
    state.busy = false;
    elements.inspectButton.disabled = false;
    if (elements.pasteButton) elements.pasteButton.disabled = false;
    elements.candidateSelect.disabled = state.candidates.length === 0;
    updateDownloadButtonLabel();
  });
}

async function inspectSource() {
  resetInspection();
  setBusy(true);
  state.queueIndex = 0;
  state.queueTotal = 1;
  state.queueProgressTotal = 1;
  if (elements.progressCard) elements.progressCard.hidden = false;
  setRuntime("inspecting", "active");
  setProgress("manifest", 5, "scanning");

  const source = await getSourceForInspection();
  const referer = elements.refererInput.value.trim();
  state.candidates = await discoverCandidates(source, referer);
  renderCandidateOptions();
  log(`Detected ${state.candidates.length} Kinescope video candidate${state.candidates.length === 1 ? "" : "s"}`);

  await inspectCandidate(getSelectedCandidate(), referer);
  if (elements.progressCard) elements.progressCard.hidden = true;
}

async function inspectSelectedCandidate() {
  if (state.candidates.length === 0) {
    await inspectSource();
    return;
  }

  setBusy(true);
  setRuntime("inspecting", "active");
  setProgress("manifest", 5, "resolving");
  await inspectCandidate(getSelectedCandidate(), elements.refererInput.value.trim());
}

async function inspectCandidate(candidate, referer) {
  if (!candidate?.videoId) {
    throw new Error("No Kinescope video candidate is selected.");
  }

  resetMediaInspection();
  state.videoId = candidate.videoId;
  elements.videoIdValue.textContent = state.videoId;
  elements.filenameInput.value = sanitizeFilename(`${state.videoId}.mp4`);

  const manifest = await fetchManifest(state.videoId, referer, candidate);
  state.manifestUrl = manifest.url;
  const parsed = manifest.type === "hls"
    ? await parseHlsManifest(manifest.text, manifest.url, referer)
    : parseMpd(manifest.text, manifest.url);
  state.videoTracks = parsed.videoTracks;
  state.audioTrack = parsed.audioTracks[parsed.audioTracks.length - 1] || null;
  state.encrypted = parsed.encrypted;
  state.encryptionKid = parsed.encryptionKid;

  if (state.videoTracks.length === 0) {
    throw new Error("No downloadable video representations were found in the DASH manifest.");
  }

  renderQualityOptions();
  updateSelectedMetadata();
  setProgress("manifest", 100, "ready");
  setRuntime("ready", "active");
  log(`Manifest loaded from ${manifest.url}`);

  const cached = state.metaCache.get(state.videoId);
  const meta = cached ?? await fetchVideoMeta(state.videoId, referer);
  if (!cached) state.metaCache.set(state.videoId, meta);
  if (meta.title) {
    state.title = meta.title;
    elements.filenameInput.value = sanitizeFilename(`${meta.title}.mp4`);
    log(`Title: ${meta.title}`);
  }
  if (meta.thumbnail) {
    state.thumbnail = meta.thumbnail;
    elements.previewVideo.poster = meta.thumbnail;
  }

  if (elements.progressCurrent) {
    elements.progressCurrent.textContent = state.title || state.videoId;
  }
}

async function fetchVideoMeta(videoId, referer) {
  try {
    const result = await postJson(API_ENDPOINTS.title, { videoId, referer });
    if (result?.title || result?.thumbnail) {
      return { title: result.title || "", thumbnail: result.thumbnail || "" };
    }
  } catch (error) {
    log(`Server title fallback: ${error.message}`);
  }

  try {
    const url = KINESCOPE_OEMBED_URL.replace("{video_id}", encodeURIComponent(videoId));
    const data = await (await fetch(url, makeFetchOptions(referer || KINESCOPE_BASE_URL))).json();
    return { title: String(data?.title || "").trim(), thumbnail: String(data?.thumbnail_url || "").trim() };
  } catch (error) {
    log(`Title lookup skipped: ${error.message}`);
    return { title: "", thumbnail: "" };
  }
}

async function downloadSelectedVideos() {
  if (state.candidates.length === 0) {
    await inspectSource();
  }

  const ids = state.selectedVideoIds.size > 0
    ? [...state.selectedVideoIds]
    : (state.candidates[0] ? [state.candidates[0].videoId] : []);
  if (ids.length === 0) {
    throw new Error(t("err.nothing"));
  }

  setBusy(true);
  state.queueIndex = 0;
  state.queueTotal = ids.length;
  state.queueProgressTotal = ids.length > 1 ? ids.length + 1 : ids.length;
  state.queueResults = [];
  speedTracker.startTime = 0;
  speedTracker.bytes = 0;
  speedTracker.lastUpdate = 0;
  speedTracker.segmentsTotal = 0;
  speedTracker.segmentsDone = 0;
  if (elements.progressCard) elements.progressCard.hidden = false;
  if (elements.resultCard) elements.resultCard.hidden = true;
  elements.steps?.classList.toggle("steps--archive", ids.length > 1);
  setRuntime("downloading", "active");

  const referer = elements.refererInput.value.trim();

  for (let i = 0; i < ids.length; i++) {
    state.queueIndex = i;
    const candidate = state.candidates.find((c) => c.videoId === ids[i])
      || { videoId: ids[i], label: ids[i] };
    await inspectCandidate(candidate, referer);
    if (ids.length === 1) {
      await downloadCurrentVideo(referer);
    } else {
      state.queueResults.push(await buildServerZipItem(referer));
    }
  }

  state.queueIndex = ids.length - 1;

  if (ids.length === 1) {
    const result = state.queueResults[0];
    if (result) showOutput(result.bytes, result.filename);
  } else {
    state.queueIndex = 0;
    state.queueTotal = 1;
    state.queueProgressTotal = 1;
    await saveAsServerZip(state.queueResults, referer);
  }

  setRuntime("complete", "active");
  markAllDone();
  clearSpeedReadout();
  log(`Queue complete: ${ids.length} video${ids.length === 1 ? "" : "s"}`);
}

async function buildServerZipItem(referer) {
  const videoTrack = pickTrackByPref(state.videoTracks, state.qualityPref);
  const audioTrack = state.audioTrack;
  const filename = sanitizeFilename(`${state.title || state.videoId}.mp4`);
  let decryptionKey = "";

  if (state.encrypted) {
    setProgress("manifest", 100, "license");
    decryptionKey = await fetchClearKey(state.videoId, state.encryptionKid, referer);
    log(`ClearKey license acquired for ${filename}`);
  }

  setProgress("ffmpeg", 100, "queued");
  log(`Queued for server ZIP: ${filename}`);
  return {
    audioSegments: audioTrack?.segments || [],
    decryptionKey,
    encryptionKid: state.encryptionKid,
    estimatedBytes: estimateTrackBytes(videoTrack) + estimateTrackBytes(audioTrack),
    filename,
    videoSegments: videoTrack.segments,
  };
}

async function downloadCurrentVideo(referer) {
  resetDownload();
  if (elements.progressCard) elements.progressCard.hidden = false;

  const videoTrack = pickTrackByPref(state.videoTracks, state.qualityPref);
  const audioTrack = state.audioTrack;
  const baseName = state.title || state.videoId;
  const filename = sanitizeFilename(
    state.queueTotal > 1
      ? `${baseName}.mp4`
      : (elements.filenameInput.value || `${baseName}.mp4`),
  );
  let decryptionKey = "";

  if (state.encrypted) {
    setProgress("manifest", 100, "license");
    decryptionKey = await fetchClearKey(state.videoId, state.encryptionKid, referer);
    log("ClearKey license acquired");
  }

  if (shouldUseServerMux(videoTrack, audioTrack, decryptionKey)) {
    const output = await muxWithServer(videoTrack, audioTrack, filename, referer, decryptionKey, state.encryptionKid);
    state.queueResults.push({ filename, bytes: output });
    setProgress("ffmpeg", 100, "complete");
    log(`Output ready: ${filename}`);
    return;
  }

  if (audioTrack) {
    log("Downloading video and audio tracks in parallel");
  }
  const [videoBytes, audioBytes] = await Promise.all([
    downloadTrack(videoTrack, "video", referer),
    audioTrack ? downloadTrack(audioTrack, "audio", referer) : Promise.resolve(null),
  ]);

  setRuntime("muxing", "active");
  const output = await muxWithFfmpeg(videoBytes, audioBytes, filename, decryptionKey);
  state.queueResults.push({ filename, bytes: output });
  setProgress("ffmpeg", 100, "complete");
  log(`Output ready: ${filename}`);
}

function shouldUseServerMux(videoTrack, audioTrack, decryptionKey) {
  if (decryptionKey) return true;
  const segmentCount = (videoTrack?.segments?.length || 0) + (audioTrack?.segments?.length || 0);
  return segmentCount >= SERVER_MUX_SEGMENT_THRESHOLD;
}

async function muxWithServer(videoTrack, audioTrack, filename, referer, decryptionKey = "", encryptionKid = "") {
  state.serverDownloadMode = true;
  setRuntime("server download", "active");
  setProgress("ffmpeg", 0, "0%");
  setProgress("video", 100, "server");
  setProgress("audio", audioTrack ? 100 : 0, audioTrack ? "server" : "none");
  const segmentCount = videoTrack.segments.length + (audioTrack?.segments.length || 0);
  const expectedBytes = estimateTrackBytes(videoTrack) + estimateTrackBytes(audioTrack);
  log(decryptionKey
    ? `Downloading from server with mp4decrypt + ffmpeg: ${segmentCount} segments`
    : `Downloading from server with native ffmpeg: ${segmentCount} segments`);

  let response;
  try {
    response = await fetch(API_ENDPOINTS.serverMux, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        audioSegments: audioTrack?.segments || [],
        decryptionKey,
        encryptionKid,
        filename,
        referer: referer || KINESCOPE_BASE_URL,
        videoSegments: videoTrack.segments,
      }),
    });
  } catch (error) {
    state.serverDownloadActive = false;
    state.serverDownloadMode = false;
    throw error;
  }

  if (!response.ok) {
    let detail = "";
    try {
      detail = (await response.json()).error || "";
    } catch {
      detail = await response.text();
    }
    state.serverDownloadActive = false;
    state.serverDownloadMode = false;
    throw new Error(`Server mux failed with HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
  }

  return readResponseBlobWithProgress(response, "ffmpeg", 0, 100, expectedBytes);
}

function estimateTrackBytes(track) {
  if (!track?.segments?.length) return 0;
  return track.segments.reduce((total, segment) => total + estimateSegmentBytes(segment), 0);
}

function estimateSegmentBytes(segment) {
  const range = String(segment?.range || "").trim();
  const match = range.match(/^(\d+)-(\d+)$/);
  if (!match) return 0;

  const start = Number.parseInt(match[1], 10);
  const end = Number.parseInt(match[2], 10);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return 0;
  return end - start + 1;
}

async function readResponseBlobWithProgress(
  response,
  progressKind,
  minProgress,
  maxProgress,
  expectedBytes = 0,
  onProgress = null,
) {
  const length = Number.parseInt(response.headers.get("Content-Length") || "0", 10);
  state.serverDownloadActive = true;
  setProgress(progressKind, minProgress, `${minProgress}%`);
  if (!response.body) {
    try {
      const blob = await response.blob();
      setProgress(progressKind, maxProgress, "100%");
      return blob;
    } finally {
      state.serverDownloadActive = false;
    }
  }

  try {
    const reader = response.body.getReader();
    const chunks = [];
    let received = 0;
    const progressBytes = Number.isFinite(length) && length > 0 ? length : expectedBytes;
    const hasLength = Number.isFinite(progressBytes) && progressBytes > 0;
    const startedAt = performance.now();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.byteLength;
      if (onProgress) onProgress(received, progressBytes);
      updateServerDownloadReadout(received, progressBytes, startedAt);
      if (hasLength) {
        const ratio = Math.max(0, Math.min(1, received / progressBytes));
        const percent = Math.min(maxProgress - 1, Math.floor(minProgress + ratio * (maxProgress - minProgress)));
        setProgress(progressKind, percent, `${percent}% · ${formatBytes(received)} / ${formatBytes(progressBytes)}`);
      } else {
        const progressWindow = Math.max(1, maxProgress - minProgress - 1);
        const slowRatio = Math.log2(received / 50_000_000 + 1) / 8;
        const percent = Math.min(maxProgress - 1, minProgress + Math.floor(Math.min(1, slowRatio) * progressWindow));
        setProgress(progressKind, percent, `${percent}% · ${formatBytes(received)}`);
      }
    }
    setProgress(progressKind, maxProgress, "100%");
    return new Blob(chunks, { type: response.headers.get("Content-Type") || "video/mp4" });
  } finally {
    state.serverDownloadActive = false;
  }
}

function updateServerDownloadReadout(received, expectedBytes, startedAt) {
  const elapsed = performance.now() - startedAt;
  if (elapsed <= 0) return;

  if (elements.speedText) {
    elements.speedText.textContent = t("speed.label", {
      rate: formatSpeed(received, elapsed),
    });
  }

  if (!elements.etaText) return;
  if (!expectedBytes || expectedBytes <= received) {
    elements.etaText.textContent = t("eta.idle");
    return;
  }

  const bytesPerMs = received / elapsed;
  if (bytesPerMs <= 0) {
    elements.etaText.textContent = t("eta.idle");
    return;
  }
  elements.etaText.textContent = formatETA((expectedBytes - received) / bytesPerMs / 1000);
}

async function saveAsServerZip(items, referer) {
  overallStage.zip = 0;
  overallStage.current = "zip";
  state.archiveDownloadMode = true;
  state.serverDownloadMode = false;
  elements.steps?.classList.add("steps--archive");
  setProgress("zip", 0, "0%");
  if (elements.stageText) elements.stageText.textContent = t("stage.downloadVideos");
  clearSpeedReadout();

  const filename = `kinescrape-${items.length}-videos.zip`;
  const expectedBytes = items.reduce((total, item) => total + (item.estimatedBytes || 0), 0);
  const cumulative = [];
  let runningTotal = 0;
  for (const item of items) {
    runningTotal += item.estimatedBytes || 0;
    cumulative.push(runningTotal);
  }
  const payload = {
    filename,
    items,
    referer: referer || KINESCOPE_BASE_URL,
  };

  log(`Downloading archive from server: ${items.length} files`);
  const response = await fetch(API_ENDPOINTS.serverZip, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    let detail = "";
    try {
      detail = (await response.json()).error || "";
    } catch {
      detail = await response.text();
    }
    throw new Error(`Server ZIP failed with HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
  }

  const blob = await readResponseBlobWithProgress(response, "zip", 0, 100, expectedBytes, (received) => {
    const index = expectedBytes > 0
      ? Math.max(0, cumulative.findIndex((limit) => received <= limit))
      : Math.min(items.length - 1, Math.floor((overallStage.zip / 100) * items.length));
    const current = index < 0 ? items.length - 1 : index;
    if (elements.progressCurrent) {
      elements.progressCurrent.textContent = `${items[current]?.filename || filename} · ${current + 1}/${items.length}`;
    }
  });
  showArchiveOutput(blob, filename, items.length);
  log(`Archive ready: ${items.length} files, ${formatBytes(blob.size)}`);
}

function showArchiveOutput(blob, filename, count) {
  if (state.downloadUrl) URL.revokeObjectURL(state.downloadUrl);
  state.downloadUrl = URL.createObjectURL(blob);
  elements.previewVideo.removeAttribute("src");
  elements.downloadLink.href = state.downloadUrl;
  elements.downloadLink.download = filename;
  const span = elements.downloadLink.querySelector("span");
  if (span) span.textContent = t("btn.saveZip");
  elements.downloadLink.hidden = false;
  if (elements.resultCard) elements.resultCard.hidden = false;
  if (elements.resultTitle) {
    elements.resultTitle.textContent = `${count} videos · ${formatBytes(blob.size)}`;
  }
  elements.downloadLink.click();
}

function setBusy(busy) {
  state.busy = busy;
  elements.inspectButton.disabled = busy;
  if (elements.pasteButton) elements.pasteButton.disabled = busy;
  elements.candidateSelect.disabled = busy || state.candidates.length === 0;
  elements.downloadButton.disabled = busy || state.selectedVideoIds.size === 0;
  syncLayoutState();
}

function resetInspection() {
  state.candidates = [];
  state.selectedVideoIds = new Set();
  state.queueIndex = 0;
  state.queueProgressTotal = 1;
  state.queueTotal = 0;
  elements.candidateSelect.replaceChildren();
  elements.candidateSelect.disabled = true;
  if (elements.candidateList) elements.candidateList.replaceChildren();
  if (elements.chooseCard) elements.chooseCard.hidden = true;
  if (elements.qualityCard) elements.qualityCard.hidden = true;
  if (elements.progressCard) {
    elements.progressCard.hidden = true;
    elements.progressCard.classList.remove("is-error");
  }
  if (elements.resultCard) elements.resultCard.hidden = true;
  if (elements.progressCurrent) elements.progressCurrent.textContent = "";
  if (elements.resultTitle) elements.resultTitle.textContent = "—";
  clearSpeedReadout();
  resetMediaInspection();
  setLog("");
  syncLayoutState();
}

function resetMediaInspection() {
  state.audioTrack = null;
  state.encrypted = false;
  state.encryptionKid = "";
  state.manifestUrl = "";
  state.thumbnail = "";
  state.title = "";
  state.videoId = "";
  state.videoTracks = [];
  elements.previewVideo.removeAttribute("poster");
  elements.qualitySelect.replaceChildren();
  elements.qualitySelect.disabled = true;
  elements.videoIdValue.textContent = "-";
  elements.trackValue.textContent = "-";
  elements.encryptionValue.textContent = "-";
  resetDownload();
  setProgress("manifest", 0, "waiting");
}

function resetDownload() {
  overallStage.manifest = 0;
  overallStage.video = 0;
  overallStage.audio = 0;
  overallStage.ffmpeg = 0;
  overallStage.zip = 0;
  overallStage.current = "manifest";
  state.archiveDownloadMode = false;
  state.serverDownloadActive = false;
  state.serverDownloadMode = false;
  elements.steps?.classList.remove("steps--archive");
  setProgress("video", 0, "waiting");
  setProgress("audio", 0, state.audioTrack ? "waiting" : "none");
  setProgress("ffmpeg", 0, "waiting");
  elements.downloadLink.hidden = true;
  elements.downloadLink.removeAttribute("href");
  if (state.downloadUrl) {
    URL.revokeObjectURL(state.downloadUrl);
    state.downloadUrl = null;
  }
}

function renderQualityOptions() {
  if (!elements.qualityPills) return;
  elements.qualityPills.replaceChildren();
  elements.qualitySelect.replaceChildren();

  for (const preset of QUALITY_PRESETS) {
    const option = document.createElement("option");
    option.value = preset.value;
    option.textContent = preset.label;
    elements.qualitySelect.append(option);

    const pill = document.createElement("button");
    pill.type = "button";
    pill.className = "qpill";
    pill.dataset.value = preset.value;
    pill.setAttribute("role", "radio");
    pill.setAttribute("aria-checked", String(preset.value === state.qualityPref));
    pill.textContent = preset.label === "Best" ? t("quality.best") : preset.label;
    pill.addEventListener("click", () => {
      state.qualityPref = preset.value;
      elements.qualitySelect.value = preset.value;
      for (const node of elements.qualityPills.querySelectorAll(".qpill")) {
        node.setAttribute("aria-checked", String(node.dataset.value === preset.value));
      }
      updateSelectedMetadata();
    });
    elements.qualityPills.append(pill);
  }

  elements.qualitySelect.value = state.qualityPref;
  elements.qualitySelect.disabled = false;
  if (elements.qualityCard) elements.qualityCard.hidden = false;

  const heights = state.videoTracks.map((t) => t.height).filter(Boolean);
  if (elements.qualityMeta && heights.length) {
    elements.qualityMeta.textContent = `available: ${heights.join("p / ")}p · audio + video combined`;
  }

  elements.downloadButton.disabled = state.selectedVideoIds.size === 0;
}

function renderCandidateOptions() {
  elements.candidateSelect.replaceChildren();
  if (elements.candidateList) elements.candidateList.replaceChildren();

  for (const [index, candidate] of state.candidates.entries()) {
    const option = document.createElement("option");
    option.value = String(index);
    option.textContent = candidate.label || candidate.videoId;
    elements.candidateSelect.append(option);
  }
  elements.candidateSelect.disabled = state.candidates.length === 0;

  state.selectedVideoIds = new Set(state.candidates.map((c) => c.videoId));

  if (elements.candidateList) {
    for (const candidate of state.candidates) {
      elements.candidateList.append(makeCandidateCard(candidate));
    }
  }

  if (elements.candidateCount) {
    const n = state.candidates.length;
    elements.candidateCount.textContent =
      n === 0 ? t("found.count.zero")
      : n === 1 ? t("found.count.one")
      : t("found.count.many", { n });
  }
  if (elements.chooseCard) elements.chooseCard.hidden = state.candidates.length <= 1;

  updateDownloadButtonLabel();
}

function makeCandidateCard(candidate) {
  const card = document.createElement("div");
  card.className = "candidate";
  card.setAttribute("role", "checkbox");
  card.setAttribute("aria-checked", "true");
  card.dataset.videoId = candidate.videoId;
  card.tabIndex = 0;

  const check = document.createElement("span");
  check.className = "check";
  check.setAttribute("aria-hidden", "true");
  check.textContent = "✓";

  const thumb = document.createElement("span");
  thumb.className = "mini-thumb";
  const thumbImg = document.createElement("img");
  thumbImg.alt = "";
  thumbImg.loading = "lazy";
  thumb.append(thumbImg);

  const info = document.createElement("span");
  info.className = "info";

  const titleSpan = document.createElement("span");
  titleSpan.className = "title";
  titleSpan.textContent = t("found.untitled");

  const subSpan = document.createElement("span");
  subSpan.className = "sub";
  subSpan.textContent = candidate.videoId;

  info.append(titleSpan, subSpan);

  const pick = document.createElement("span");
  pick.className = "pick";
  pick.textContent = t("found.included");

  card.append(check, thumb, info, pick);

  loadCandidateMeta(candidate.videoId).then((meta) => {
    if (meta?.title) titleSpan.textContent = meta.title;
    if (meta?.thumbnail) thumbImg.src = meta.thumbnail;
  });

  const toggle = () => {
    const checked = card.getAttribute("aria-checked") === "true";
    if (checked) {
      state.selectedVideoIds.delete(candidate.videoId);
      card.setAttribute("aria-checked", "false");
      check.textContent = "";
      pick.textContent = t("found.skipped");
    } else {
      state.selectedVideoIds.add(candidate.videoId);
      card.setAttribute("aria-checked", "true");
      check.textContent = "✓";
      pick.textContent = t("found.included");
    }
    updateDownloadButtonLabel();
  };
  card.addEventListener("click", toggle);
  card.addEventListener("keydown", (event) => {
    if (event.key === " " || event.key === "Enter") {
      event.preventDefault();
      toggle();
    }
  });
  return card;
}

async function loadCandidateMeta(videoId) {
  if (state.metaCache.has(videoId)) return state.metaCache.get(videoId);
  const referer = elements.refererInput.value.trim();
  try {
    const meta = await fetchVideoMeta(videoId, referer);
    state.metaCache.set(videoId, meta);
    return meta;
  } catch {
    return { title: "", thumbnail: "" };
  }
}

function updateDownloadButtonLabel() {
  const n = state.selectedVideoIds.size;
  const label = elements.downloadButton.querySelector("span");
  if (label) {
    label.textContent = n > 1 ? t("btn.getMany", { n }) : t("btn.get");
  }
  elements.downloadButton.disabled = n === 0;
}

function updateSelectedMetadata() {
  const videoTrack = pickTrackByPref(state.videoTracks, state.qualityPref);
  const trackCount = `${state.videoTracks.length} video / ${state.audioTrack ? 1 : 0} audio`;
  elements.trackValue.textContent = videoTrack ? `${formatTrackLabel(videoTrack)}; ${trackCount}` : trackCount;
  elements.encryptionValue.textContent = state.encrypted ? "ClearKey" : "none";
}

function pickTrackByPref(tracks, pref) {
  if (!tracks?.length) return null;
  if (pref === "best") return tracks[tracks.length - 1];
  const target = Number(pref);
  if (!Number.isFinite(target)) return tracks[tracks.length - 1];
  const lessOrEqual = tracks.filter((t) => (t.height || 0) <= target);
  if (lessOrEqual.length) return lessOrEqual[lessOrEqual.length - 1];
  return tracks[0];
}

function getSelectedVideoTrack() {
  return pickTrackByPref(state.videoTracks, state.qualityPref);
}

function getSelectedCandidate() {
  if (state.candidates.length === 1) return state.candidates[0];
  const id = state.selectedVideoIds.values().next().value;
  return state.candidates.find((c) => c.videoId === id) || state.candidates[0];
}

async function getSourceForInspection() {
  const current = elements.sourceInput.value.trim();
  if (current) {
    return current;
  }

  if (navigator.clipboard?.readText) {
    try {
      const clipboardText = (await navigator.clipboard.readText()).trim();
      if (clipboardText) {
        elements.sourceInput.value = clipboardText;
        return clipboardText;
      }
    } catch {
      // Some browsers only expose clipboard contents through the paste event.
    }
  }

  throw new Error(t("err.empty"));
}

async function discoverCandidates(source, referer) {
  const localCandidates = extractCandidatesFromSource(source);
  if (localCandidates.length > 0 && !isSingleRemotePageUrl(source)) {
    return localCandidates;
  }

  try {
    const result = await postJson(API_ENDPOINTS.extract, { source, referer });
    const serverCandidates = normalizeCandidates(result.candidates || []);
    if (serverCandidates.length > 0) {
      return serverCandidates;
    }
  } catch (error) {
    log(`Server extract fallback: ${error.message}`);
  }

  if (localCandidates.length > 0) {
    return localCandidates;
  }

  if (isHttpUrl(source)) {
    log("Fetching source page to locate Kinescope links");
    const html = await fetchText(source, referer);
    const remoteCandidates = extractCandidatesFromSource(html, source);
    if (remoteCandidates.length > 0) {
      return remoteCandidates;
    }
  }

  const videoId = await resolveVideoId(source, referer);
  return normalizeCandidates([{ videoId, label: videoId, source: "resolved" }]);
}

function extractCandidatesFromSource(source, baseUrl = "") {
  const candidates = [];
  const trimmed = source.trim();

  if (VIDEO_ID_PATTERN.test(trimmed) && !trimmed.includes("://")) {
    candidates.push({ videoId: trimmed, label: trimmed, source: "video-id" });
  }

  collectCandidatesFromText(trimmed, candidates);

  if (looksLikeHtml(trimmed)) {
    collectCandidatesFromHtml(trimmed, baseUrl, candidates);
  }

  return normalizeCandidates(candidates);
}

function collectCandidatesFromHtml(html, baseUrl, candidates) {
  const attrPattern = /(href|src|data-kinescope-id|data-video-id|data-id)\s*=\s*["']([^"']+)["']/gi;
  for (const match of String(html).matchAll(attrPattern)) {
    const attribute = match[1].toLowerCase();
    const value = match[2];
    if (!value) {
      continue;
    }

    const resolved = resolveMaybeUrl(value, baseUrl);
    const videoId = inferVideoIdFromValue(resolved || value);
    if (videoId) {
      candidates.push({
        label: labelForCandidate(videoId, resolved || value),
        source: attribute,
        url: resolved || value,
        videoId,
      });
    }
  }
}

function collectCandidatesFromText(text, candidates) {
  for (const manifestUrl of hlsManifestUrlsFromText(text)) {
    const videoId = inferVideoIdFromValue(manifestUrl);
    if (videoId) {
      candidates.push({
        label: labelForCandidate(videoId, manifestUrl),
        manifestType: "hls",
        manifestUrl,
        source: "hls",
        url: manifestUrl,
        videoId,
      });
    }
  }

  const patterns = [
    /(?:https?:)?\/\/(?:[^\s"'<>/@]+(?::[^\s"'<>/@]*)?@)?(?:[^/\s"'<>]+\.)?kinescope\.io\/(?:embed\/|player\/|new-manifest\/|video\/)?([A-Za-z0-9_-]{6,})[^\s"'<>]*/gi,
    /data-kinescope-id=["']([A-Za-z0-9_-]{6,})["']/gi,
    /\bid:\s*["']([A-Za-z0-9_-]{6,})["']/gi,
  ];

  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      candidates.push({
        label: labelForCandidate(match[1], match[0]),
        source: "text",
        url: match[0],
        videoId: match[1],
      });
    }
  }
}

function normalizeCandidates(candidates) {
  const byId = new Map();
  const result = [];
  for (const candidate of candidates) {
    const videoId = String(candidate.videoId || "").trim();
    if (!isValidVideoId(videoId)) {
      continue;
    }
    const existing = byId.get(videoId);
    if (existing) {
      for (const key of ["manifestUrl", "manifestType", "title", "thumbnail", "url"]) {
        if (!existing[key] && candidate[key]) existing[key] = candidate[key];
      }
      if (existing.source !== "hls" && candidate.source === "hls") {
        existing.source = "hls";
        existing.label = candidate.label || existing.label;
      }
      continue;
    }

    const item = {
      label: candidate.label || labelForCandidate(videoId, candidate.url || ""),
      manifestType: candidate.manifestType || "",
      manifestUrl: candidate.manifestUrl || "",
      source: candidate.source || "source",
      thumbnail: candidate.thumbnail || "",
      title: candidate.title || "",
      url: candidate.url || "",
      videoId,
    };
    byId.set(videoId, item);
    result.push(item);
  }
  return result;
}

function hlsManifestUrlsFromText(text) {
  const urls = [];
  const pattern = /https:\/\/kinescope\.io\/[A-Za-z0-9_-]+\/master\.m3u8\?[^"'<\s]+/g;
  for (const match of text.matchAll(pattern)) {
    const url = decodeEmbeddedUrl(match[0]);
    if (!urls.includes(url)) urls.push(url);
  }
  return urls;
}

function decodeEmbeddedUrl(value) {
  return String(value).replace(/&amp;|\\u0026/g, "&");
}

function labelForCandidate(videoId, url) {
  if (!url) {
    return videoId;
  }

  try {
    const parsed = new URL(url.startsWith("//") ? `https:${url}` : url);
    parsed.username = "";
    parsed.password = "";
    return `${videoId} - ${parsed.hostname}`;
  } catch {
    return videoId;
  }
}

function inferVideoIdFromValue(value) {
  const trimmed = value.trim();
  if (isValidVideoId(trimmed) && !trimmed.includes("://")) {
    return trimmed;
  }

  try {
    return inferVideoIdFromUrl(new URL(trimmed.startsWith("//") ? `https:${trimmed}` : trimmed));
  } catch {
    return "";
  }
}

function looksLikeHtml(value) {
  return /<[a-zA-Z][a-zA-Z0-9]*[\s>/]/.test(value);
}

function isKinescopeHost(hostname) {
  if (!hostname) return false;
  const host = String(hostname).toLowerCase().replace(/\.+$/, "");
  return host === "kinescope.io" || host.endsWith(".kinescope.io");
}

function isSingleRemotePageUrl(value) {
  const trimmed = value.trim();
  if (!isHttpUrl(trimmed)) return false;

  const url = new URL(trimmed);
  if (!isKinescopeHost(url.hostname)) return true;

  const firstPart = url.pathname.split("/").find(Boolean) || "";
  if (KINESCOPE_RESERVED_IDS.has(firstPart)) return false;
  if (url.pathname.endsWith(".mpd") || url.pathname.endsWith(".m3u8")) return false;
  return true;
}

function resolveMaybeUrl(value, baseUrl) {
  try {
    if (baseUrl) {
      return new URL(value, baseUrl).href;
    }
    if (value.startsWith("//")) {
      return `https:${value}`;
    }
    return new URL(value).href;
  } catch {
    return "";
  }
}

async function resolveVideoId(source, referer) {
  if (!source) {
    throw new Error("Enter a Kinescope URL or video ID.");
  }

  if (isValidVideoId(source) && !source.includes("://")) {
    return source;
  }

  let url;
  try {
    url = new URL(source);
  } catch {
    throw new Error("The source must be a valid URL or a Kinescope video ID.");
  }

  const inferred = inferVideoIdFromUrl(url);
  if (inferred) {
    return inferred;
  }

  log("Fetching source page to locate the embedded Kinescope ID");
  const html = await fetchText(url.href, referer);
  const parsed = extractVideoIdFromHtml(html);
  if (parsed) {
    return parsed;
  }

  throw new Error("Could not find a Kinescope video ID in the supplied URL.");
}

function inferVideoIdFromUrl(url) {
  for (const key of ["video_id", "videoId", "video", "id"]) {
    const value = url.searchParams.get(key);
    if (isValidVideoId(value || "")) {
      return value;
    }
  }

  if (!isKinescopeHost(url.hostname)) {
    return "";
  }

  const pathParts = url.pathname
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => !KINESCOPE_RESERVED_IDS.has(part));

  return pathParts.find((part) => isValidVideoId(part)) || "";
}

function extractVideoIdFromHtml(html) {
  const patterns = [
    /\bid:\s*["']([A-Za-z0-9_-]{6,})["']/,
    /data-kinescope-id=["']([A-Za-z0-9_-]{6,})["']/,
    /(?:https?:)?\/\/(?:[^\s"'<>/@]+(?::[^\s"'<>/@]*)?@)?(?:[^/\s"'<>]+\.)?kinescope\.io\/(?:embed\/|player\/|new-manifest\/|video\/)?([A-Za-z0-9_-]{6,})/,
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match && isValidVideoId(match[1])) {
      return match[1];
    }
  }

  return "";
}

function isValidVideoId(value) {
  return VIDEO_ID_PATTERN.test(value || "") && !KINESCOPE_RESERVED_IDS.has(value);
}

async function fetchManifest(videoId, referer, candidate = {}) {
  if (candidate.manifestUrl) {
    const result = await postJson(API_ENDPOINTS.manifest, {
      manifestUrl: candidate.manifestUrl,
      referer,
    });
    return {
      text: result.text,
      type: result.type || candidate.manifestType || inferManifestType(candidate.manifestUrl, result.text),
      url: result.url || candidate.manifestUrl,
    };
  }

  try {
    const result = await postJson(API_ENDPOINTS.manifest, { videoId, referer });
    if (result.text && result.url) {
      return { ...result, type: result.type || inferManifestType(result.url, result.text) };
    }
  } catch (error) {
    log(`Server manifest fallback: ${error.message}`);
  }

  let lastError;
  for (const template of MANIFEST_URLS) {
    const url = template.replace("{video_id}", encodeURIComponent(videoId));
    try {
      setProgress("manifest", 40, "fetching");
      const text = await fetchText(url, referer || KINESCOPE_BASE_URL);
      return { text, type: inferManifestType(url, text), url };
    } catch (error) {
      lastError = error;
      log(`Manifest request failed: ${url}`);
    }
  }

  throw lastError || new Error("The manifest could not be loaded.");
}

function inferManifestType(url, text = "") {
  if (url.includes(".m3u8") || String(text).trimStart().startsWith("#EXTM3U")) {
    return "hls";
  }
  return "dash";
}

async function fetchText(url, referer) {
  const safeUrl = assertKinescopeUrl(url);
  let response;
  try {
    response = await fetch(safeUrl, makeFetchOptions(referer));
  } catch (error) {
    throw new Error(`Browser fetch failed for ${safeUrl}. CORS or referer policy may block this request. ${error.message}`);
  }

  if (!response.ok) {
    throw new Error(`Request failed with HTTP ${response.status} for ${safeUrl}`);
  }

  return response.text();
}

function assertKinescopeUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Invalid URL.");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("Only HTTP(S) URLs are allowed.");
  }
  if (!isKinescopeHost(parsed.hostname)) {
    throw new Error("Only Kinescope URLs are allowed for browser-side fetches.");
  }
  return parsed.toString();
}

async function fetchJson(url, referer, body) {
  let response;
  try {
    response = await fetch(url, makeFetchOptions(referer, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }));
  } catch (error) {
    throw new Error(`Browser fetch failed for ${url}. CORS or referer policy may block this request. ${error.message}`);
  }

  if (!response.ok) {
    throw new Error(`License request failed with HTTP ${response.status}.`);
  }

  return response.json();
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  let payload = {};
  try {
    payload = await response.json();
  } catch {
    // Keep the original HTTP status error below if the server did not return JSON.
  }

  if (!response.ok) {
    throw new Error(payload.error || `HTTP ${response.status}`);
  }

  return payload;
}

function makeFetchOptions(referer, extra = {}) {
  const options = {
    credentials: "omit",
    mode: "cors",
    ...extra,
  };

  if (isHttpUrl(referer)) {
    options.referrer = referer;
  }

  return options;
}

async function parseHlsManifest(masterText, masterUrl, referer) {
  const master = parseHlsMaster(masterText, masterUrl);
  const audioTracks = [];
  const videoTracks = [];

  for (const audio of master.audio) {
    const playlist = await fetchManifestUrl(audio.url, referer);
    audioTracks.push({
      bandwidth: 0,
      id: audio.name || audio.groupId || "audio",
      segments: parseHlsMediaPlaylist(playlist.text, playlist.url),
      type: "audio",
    });
  }

  for (const variant of master.variants) {
    const playlist = await fetchManifestUrl(variant.url, referer);
    videoTracks.push({
      bandwidth: variant.bandwidth,
      height: variant.height,
      id: variant.quality || String(variant.height || variant.bandwidth || ""),
      segments: parseHlsMediaPlaylist(playlist.text, playlist.url),
      type: "video",
      width: variant.width,
    });
  }

  videoTracks.sort((left, right) => (left.height || 0) - (right.height || 0));
  return { audioTracks, encrypted: false, encryptionKid: "", videoTracks };
}

async function fetchManifestUrl(manifestUrl, referer) {
  const result = await postJson(API_ENDPOINTS.manifest, {
    manifestUrl,
    referer,
  });
  return {
    text: result.text,
    type: result.type || inferManifestType(result.url || manifestUrl, result.text),
    url: result.url || manifestUrl,
  };
}

function parseHlsMaster(text, masterUrl) {
  const audio = [];
  const variants = [];
  let pendingVariant = null;

  for (const line of hlsLines(text)) {
    if (line.startsWith("#EXT-X-MEDIA:")) {
      const attrs = parseHlsAttributes(line);
      if (attrs.TYPE === "AUDIO" && attrs.URI) {
        audio.push({
          groupId: attrs["GROUP-ID"] || "",
          name: attrs.NAME || "",
          url: resolveUrl(attrs.URI, masterUrl),
        });
      }
      continue;
    }

    if (line.startsWith("#EXT-X-STREAM-INF:")) {
      pendingVariant = parseHlsAttributes(line);
      continue;
    }

    if (!line || line.startsWith("#") || !pendingVariant) {
      continue;
    }

    const [width, height] = String(pendingVariant.RESOLUTION || "")
      .split("x")
      .map((part) => Number.parseInt(part, 10));
    variants.push({
      audioGroup: pendingVariant.AUDIO || "",
      bandwidth: Number.parseInt(pendingVariant.BANDWIDTH || "0", 10) || 0,
      height: Number.isFinite(height) ? height : 0,
      quality: new URL(resolveUrl(line, masterUrl)).searchParams.get("quality") || "",
      url: resolveUrl(line, masterUrl),
      width: Number.isFinite(width) ? width : 0,
    });
    pendingVariant = null;
  }

  return { audio, variants };
}

function parseHlsMediaPlaylist(text, playlistUrl) {
  const segments = [];
  let pendingRange = "";
  let nextOffset = 0;

  for (const line of hlsLines(text)) {
    if (line.startsWith("#EXT-X-KEY:")) {
      const attrs = parseHlsAttributes(line);
      if (attrs.METHOD && attrs.METHOD !== "NONE") {
        throw new Error(`Encrypted HLS streams are not supported yet (${attrs.METHOD}).`);
      }
      continue;
    }

    if (line.startsWith("#EXT-X-MAP:")) {
      const attrs = parseHlsAttributes(line);
      if (attrs.URI) {
        segments.push({
          range: hlsByteRangeToHttpRange(attrs.BYTERANGE || "0@0", 0).range,
          url: resolveUrl(attrs.URI, playlistUrl),
        });
      }
      continue;
    }

    if (line.startsWith("#EXT-X-BYTERANGE:")) {
      pendingRange = line.slice("#EXT-X-BYTERANGE:".length).trim();
      continue;
    }

    if (!line || line.startsWith("#")) {
      continue;
    }

    const parsedRange = hlsByteRangeToHttpRange(pendingRange, nextOffset);
    nextOffset = parsedRange.nextOffset;
    segments.push({
      range: parsedRange.range,
      url: resolveUrl(line, playlistUrl),
    });
    pendingRange = "";
  }

  return dedupeSegments(segments);
}

function hlsLines(text) {
  return String(text)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function parseHlsAttributes(line) {
  const source = line.includes(":") ? line.slice(line.indexOf(":") + 1) : line;
  const attrs = {};
  for (const match of source.matchAll(/([A-Z0-9-]+)=("[^"]*"|[^,]*)/g)) {
    const raw = match[2].trim();
    attrs[match[1]] = raw.startsWith("\"") && raw.endsWith("\"")
      ? raw.slice(1, -1)
      : raw;
  }
  return attrs;
}

function hlsByteRangeToHttpRange(value, defaultOffset) {
  const [lengthText, offsetText] = String(value || "").split("@");
  const length = Number.parseInt(lengthText, 10);
  if (!Number.isFinite(length) || length <= 0) {
    return { nextOffset: defaultOffset, range: "" };
  }

  const offset = offsetText === undefined ? defaultOffset : Number.parseInt(offsetText, 10);
  const start = Number.isFinite(offset) ? offset : defaultOffset;
  const end = start + length - 1;
  return { nextOffset: end + 1, range: `${start}-${end}` };
}

function parseMpd(mpdText, manifestUrl) {
  const documentXml = new DOMParser().parseFromString(mpdText, "application/xml");
  if (findFirst(documentXml, "parsererror")) {
    throw new Error("The manifest XML could not be parsed.");
  }

  const root = documentXml.documentElement;
  const rootBase = resolveUrl(childText(root, "BaseURL"), manifestUrl);
  const periods = children(root, "Period");
  const searchRoots = periods.length ? periods : [root];
  const videoTracks = [];
  const audioTracks = [];
  let encrypted = false;
  let encryptionKid = "";

  for (const period of searchRoots) {
    const periodBase = resolveUrl(childText(period, "BaseURL"), rootBase);
    for (const adaptation of descendants(period, "AdaptationSet")) {
      const adaptationBase = resolveUrl(childText(adaptation, "BaseURL"), periodBase);
      const contentType = getTrackType(adaptation);
      const protections = descendants(adaptation, "ContentProtection");
      const kid = findEncryptionKid(protections);

      if (protections.length > 0) {
        encrypted = true;
        encryptionKid = encryptionKid || kid;
      }

      for (const representation of children(adaptation, "Representation")) {
        const type = getTrackType(representation) || contentType;
        if (!["video", "audio"].includes(type)) {
          continue;
        }

        const representationBase = resolveUrl(childText(representation, "BaseURL"), adaptationBase);
        const segments = collectSegments(representation, adaptation, representationBase);
        if (segments.length === 0) {
          continue;
        }

        const track = {
          bandwidth: numberAttribute(representation, "bandwidth"),
          height: numberAttribute(representation, "height"),
          id: representation.getAttribute("id") || "",
          segments,
          type,
          width: numberAttribute(representation, "width"),
        };

        if (type === "video") {
          videoTracks.push(track);
        } else {
          audioTracks.push(track);
        }
      }
    }
  }

  videoTracks.sort((left, right) => (left.height || 0) - (right.height || 0));
  audioTracks.sort((left, right) => (left.bandwidth || 0) - (right.bandwidth || 0));

  if (encrypted && !encryptionKid) {
    throw new Error("The stream is encrypted, but the manifest does not expose a ClearKey KID.");
  }

  return { audioTracks, encrypted, encryptionKid, videoTracks };
}

function collectSegments(representation, adaptation, baseUrl) {
  const segmentList = firstChild(representation, "SegmentList") || firstChild(adaptation, "SegmentList");
  if (!segmentList) {
    if (firstChild(representation, "SegmentTemplate") || firstChild(adaptation, "SegmentTemplate")) {
      throw new Error("This browser client currently supports SegmentList DASH manifests only.");
    }
    return [];
  }

  const segments = [];
  const initialization = firstChild(segmentList, "Initialization");
  if (initialization) {
    const sourceURL = initialization.hasAttribute("sourceURL")
      ? initialization.getAttribute("sourceURL") || ""
      : "";
    segments.push({
      range: initialization.getAttribute("range") || "",
      url: resolveUrl(sourceURL, baseUrl),
    });
  }

  for (const segmentUrl of children(segmentList, "SegmentURL")) {
    const media = segmentUrl.getAttribute("media") || "";
    const range = segmentUrl.getAttribute("mediaRange") || "";
    segments.push({
      range,
      url: resolveUrl(media, baseUrl),
    });
  }

  return dedupeSegments(segments);
}

async function fetchClearKey(videoId, kid, referer) {
  if (!kid) {
    throw new Error("The stream is encrypted, but no ClearKey KID was found.");
  }

  try {
    const result = await postJson(API_ENDPOINTS.license, { videoId, kid, referer });
    if (result.key) {
      return result.key;
    }
  } catch (error) {
    log(`Server license fallback: ${error.message}`);
  }

  const licenseUrl = CLEARKEY_LICENSE_URL.replace("{video_id}", encodeURIComponent(videoId));
  const license = await fetchJson(licenseUrl, referer || KINESCOPE_BASE_URL, {
    kids: [base64UrlEncode(hexToBytes(kid.replaceAll("-", "")))],
    type: "temporary",
  });

  const key = license?.keys?.[0]?.k;
  if (!key) {
    throw new Error("The ClearKey license response did not include a content key.");
  }

  return bytesToHex(base64UrlToBytes(key));
}

async function downloadTrack(track, kind, referer) {
  setProgress(kind, 0, "0%");
  log(`Downloading ${kind}: ${track.segments.length} segments × ${SEGMENT_CONCURRENCY} parallel`);

  if (speedTracker.startTime === 0) speedTracker.startTime = performance.now();
  speedTracker.segmentsTotal += track.segments.length;

  const total = track.segments.length;
  const chunks = new Array(total);
  let totalBytes = 0;
  let completed = 0;
  let cursor = 0;
  let aborted = null;

  async function worker() {
    while (cursor < total && !aborted) {
      const index = cursor++;
      try {
        const bytes = await fetchSegment(track.segments[index], referer);
        chunks[index] = bytes;
        totalBytes += bytes.byteLength;
        speedTracker.bytes += bytes.byteLength;
        speedTracker.segmentsDone += 1;
        completed += 1;
        const percent = Math.round((completed / total) * 100);
        setProgress(kind, percent, `${percent}%`);
        updateSpeedReadout();
      } catch (error) {
        aborted = error;
        return;
      }
    }
  }

  const workers = Array.from({ length: Math.min(SEGMENT_CONCURRENCY, total) }, worker);
  await Promise.all(workers);
  if (aborted) throw aborted;

  const elapsed = performance.now() - speedTracker.startTime;
  log(`${kind} done: ${formatBytes(totalBytes)} @ ${formatSpeed(totalBytes, elapsed)}/s`);
  return concatenate(chunks, totalBytes);
}

function updateSpeedReadout() {
  const now = performance.now();
  if (now - speedTracker.lastUpdate < 250) return;
  speedTracker.lastUpdate = now;
  const elapsed = now - speedTracker.startTime;
  if (elapsed <= 0) return;

  if (elements.speedText) {
    elements.speedText.textContent = t("speed.label", {
      rate: formatSpeed(speedTracker.bytes, elapsed),
    });
  }
  if (elements.etaText) {
    elements.etaText.textContent = formatETA(estimateETASeconds());
  }
}

function estimateETASeconds() {
  const elapsed = performance.now() - speedTracker.startTime;
  if (elapsed <= 0) return Infinity;

  const queueRatio = state.queueTotal > 0
    ? (state.queueIndex + (speedTracker.segmentsTotal > 0 ? speedTracker.segmentsDone / speedTracker.segmentsTotal : 0)) / state.queueTotal
    : (speedTracker.segmentsTotal > 0 ? speedTracker.segmentsDone / speedTracker.segmentsTotal : 0);

  if (queueRatio <= 0 || queueRatio >= 1) return 0;
  const remaining = (elapsed / queueRatio) * (1 - queueRatio);
  return remaining / 1000;
}

function clearSpeedReadout() {
  if (elements.speedText) elements.speedText.textContent = t("speed.idle");
  if (elements.etaText) elements.etaText.textContent = t("eta.idle");
  speedTracker.segmentsTotal = 0;
  speedTracker.segmentsDone = 0;
}

function formatSpeed(bytes, ms) {
  if (ms <= 0) return "0 B";
  const bps = (bytes / ms) * 1000;
  if (bps >= 1_048_576) return `${(bps / 1_048_576).toFixed(1)} MB`;
  if (bps >= 1024) return `${(bps / 1024).toFixed(0)} KB`;
  return `${Math.round(bps)} B`;
}

function formatETA(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return t("eta.idle");
  const s = Math.round(seconds);
  if (s < 60) return t("eta.seconds", { s });
  const m = Math.floor(s / 60);
  if (m < 60) return t("eta.minutes", { m, s: s % 60 });
  const h = Math.floor(m / 60);
  return t("eta.hours", { h, m: m % 60 });
}

async function fetchSegment(segment, referer) {
  try {
    const response = await fetch(API_ENDPOINTS.segment, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        range: segment.range || "",
        referer: referer || KINESCOPE_BASE_URL,
        url: segment.url,
      }),
    });
    if (response.ok) {
      return new Uint8Array(await response.arrayBuffer());
    }
    log(`Server segment fallback: HTTP ${response.status}`);
  } catch (error) {
    log(`Server segment fallback: ${error.message}`);
  }

  const headers = {};
  if (segment.range) {
    headers.Range = `bytes=${segment.range}`;
  }

  let response;
  try {
    response = await fetch(segment.url, makeFetchOptions(referer || KINESCOPE_BASE_URL, { headers }));
  } catch (error) {
    throw new Error(`Segment fetch failed for ${segment.url}. ${error.message}`);
  }

  if (!response.ok && response.status !== 206) {
    throw new Error(`Segment request failed with HTTP ${response.status} for ${segment.url}`);
  }

  return new Uint8Array(await response.arrayBuffer());
}

async function muxWithFfmpeg(videoBytes, audioBytes, filename, decryptionKey) {
  const ffmpeg = await ensureFfmpeg();
  const videoInput = decryptionKey ? "video.enc.mp4" : "video.mp4";
  const audioInput = audioBytes ? (decryptionKey ? "audio.enc.mp4" : "audio.mp4") : "";
  const outputName = sanitizeFilename(filename);
  const inputBytes = videoBytes.byteLength + (audioBytes?.byteLength || 0);

  setProgress("ffmpeg", 18, "writing");
  await ffmpeg.writeFile(videoInput, videoBytes);
  if (audioBytes) {
    await ffmpeg.writeFile(audioInput, audioBytes);
  }

  const args = ["-hide_banner", "-loglevel", "warning"];
  if (decryptionKey) {
    args.push("-decryption_key", decryptionKey);
  }
  args.push("-i", videoInput);
  if (audioBytes) {
    if (decryptionKey) {
      args.push("-decryption_key", decryptionKey);
    }
    args.push("-i", audioInput, "-map", "0:v:0", "-map", "1:a:0");
  } else {
    args.push("-map", "0:v:0");
  }
  args.push("-c", "copy");
  if (inputBytes <= FASTSTART_MAX_INPUT_BYTES) {
    args.push("-movflags", "faststart");
  } else {
    log(`Large output (${formatBytes(inputBytes)}): skipping faststart to avoid browser ffmpeg stall`);
  }
  args.push(outputName);

  setProgress("ffmpeg", 35, "muxing");
  const exitCode = await runFfmpegExec(ffmpeg, args, inputBytes);
  if (exitCode !== 0) {
    throw new Error(`ffmpeg exited with code ${exitCode}.`);
  }

  setProgress("ffmpeg", 92, "reading");
  const output = await ffmpeg.readFile(outputName);
  await cleanupFfmpegFiles(ffmpeg, [videoInput, audioInput, outputName].filter(Boolean));
  return output;
}

async function runFfmpegExec(ffmpeg, args, inputBytes) {
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      try {
        ffmpeg.terminate();
      } catch {
        // The exec path is already failing; termination is best effort.
      }
      state.ffmpeg = null;
      reject(new Error(
        `ffmpeg.wasm stalled while muxing ${formatBytes(inputBytes)}. Try a lower quality or use native/server-side ffmpeg for this file size.`,
      ));
    }, FFMPEG_EXEC_TIMEOUT_MS);
  });

  try {
    return await Promise.race([ffmpeg.exec(args), timeoutPromise]);
  } finally {
    clearTimeout(timeoutId);
  }
}

async function ensureFfmpeg() {
  if (state.ffmpeg?.loaded) {
    return state.ffmpeg;
  }

  setRuntime("loading ffmpeg", "active");
  setProgress("ffmpeg", 1, "loading");
  if (elements.stageText) elements.stageText.textContent = t("stage.loadingCombiner");
  log("Loading ffmpeg.wasm runtime");

  const ffmpeg = new FFmpeg();
  ffmpeg.on("log", ({ message }) => {
    if (message) {
      log(`ffmpeg: ${message}`);
    }
  });
  ffmpeg.on("progress", ({ progress }) => {
    if (!Number.isFinite(progress)) return;
    const percent = Math.max(0, Math.min(100, Math.round(progress * 100)));
    setProgress("ffmpeg", percent, `${percent}%`);
    if (elements.stageText) {
      const suffix = state.queueTotal > 1
        ? ` · ${t("queue.of", { i: state.queueIndex + 1, n: state.queueTotal })}`
        : "";
      elements.stageText.textContent = `${t("stage.combineProgress", { p: percent })}${suffix}`;
    }
  });

  try {
    log("Fetching ffmpeg worker and core via same-origin assets");
    await loadFfmpegWithTimeout(ffmpeg, {
      coreURL: versionedAssetUrl("/vendor/ffmpeg/ffmpeg-core.js"),
      wasmURL: versionedAssetUrl("/vendor/ffmpeg/ffmpeg-core.wasm"),
    });
  } catch (error) {
    const msg = error?.message || String(error);
    log(`same-origin ffmpeg core failed: ${msg}`);
    log("Retrying ffmpeg core from CDN blob URLs");
    try {
      try {
        ffmpeg.terminate();
      } catch {
        // Best-effort reset before retrying with the CDN core.
      }
      await loadFfmpegWithTimeout(ffmpeg, {
        coreURL: `${FFMPEG_CORE_FALLBACK_BASE}/ffmpeg-core.js`,
        wasmURL: `${FFMPEG_CORE_FALLBACK_BASE}/ffmpeg-core.wasm`,
      });
    } catch (fallbackError) {
      const fallbackMsg = fallbackError?.message || String(fallbackError);
      log(`ffmpeg load failed: ${fallbackMsg}`);
      throw new Error(`ffmpeg.wasm could not load: ${fallbackMsg}`);
    }
  }

  state.ffmpeg = ffmpeg;
  setProgress("ffmpeg", 2, "loaded");
  log("ffmpeg.wasm loaded ✓");
  return ffmpeg;
}

async function loadFfmpegWithTimeout(ffmpeg, urls) {
  const [classWorkerURL, coreURL, wasmURL] = await Promise.all([
    ensureFfmpegWorkerURL(),
    toBlobURL(urls.coreURL, "text/javascript"),
    toBlobURL(urls.wasmURL, "application/wasm"),
  ]);
  const loadPromise = ffmpeg.load({
    classWorkerURL,
    coreURL,
    wasmURL,
  });
  loadPromise.catch(() => {});

  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error("ffmpeg.wasm load timed out after 60s. Check network or browser console."));
    }, 60_000);
  });

  try {
    await Promise.race([loadPromise, timeoutPromise]);
  } finally {
    clearTimeout(timeoutId);
  }
}

function ensureFfmpegWorkerURL() {
  if (!ffmpegWorkerURLPromise) {
    ffmpegWorkerURLPromise = toBlobURL(versionedAssetUrl("/ffmpeg-worker.js"), "text/javascript")
      .catch((error) => {
        ffmpegWorkerURLPromise = null;
        throw error;
      });
  }
  return ffmpegWorkerURLPromise;
}

async function toBlobURL(url, mimeType) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${url} returned HTTP ${response.status}`);
  }

  const blob = await response.blob();
  return URL.createObjectURL(new Blob([blob], { type: mimeType }));
}

async function cleanupFfmpegFiles(ffmpeg, paths) {
  for (const path of paths) {
    try {
      await ffmpeg.deleteFile(path);
    } catch {
      // The virtual FS cleanup is best-effort; a missing file does not affect the output.
    }
  }
}

function showOutput(data, filename) {
  const blob = data instanceof Blob ? data : new Blob([data], { type: "video/mp4" });
  if (state.downloadUrl) URL.revokeObjectURL(state.downloadUrl);
  state.downloadUrl = URL.createObjectURL(blob);
  elements.previewVideo.src = state.downloadUrl;
  elements.downloadLink.href = state.downloadUrl;
  elements.downloadLink.download = sanitizeFilename(filename);
  const span = elements.downloadLink.querySelector("span");
  if (span) span.textContent = t("btn.save");
  elements.downloadLink.hidden = false;
  if (elements.resultCard) elements.resultCard.hidden = false;
  if (elements.resultTitle) {
    elements.resultTitle.textContent = state.title || filename.replace(/\.mp4$/i, "");
  }
  elements.downloadLink.click();
}

function getTrackType(element) {
  const mimeType = (element.getAttribute("mimeType") || "").toLowerCase();
  const contentType = (element.getAttribute("contentType") || "").toLowerCase();
  if (mimeType.includes("video") || contentType === "video") {
    return "video";
  }
  if (mimeType.includes("audio") || contentType === "audio") {
    return "audio";
  }
  return "";
}

function findEncryptionKid(protections) {
  for (const protection of protections) {
    const kid = protection.getAttribute("cenc:default_KID")
      || protection.getAttribute("default_KID")
      || protection.getAttribute("default_KID".toLowerCase());
    if (kid) {
      return kid;
    }
  }
  return "";
}

function children(parent, localName) {
  return Array.from(parent?.children || []).filter((child) => child.localName === localName);
}

function descendants(parent, localName) {
  return Array.from(parent?.getElementsByTagName("*") || []).filter((child) => child.localName === localName);
}

function firstChild(parent, localName) {
  return children(parent, localName)[0] || null;
}

function findFirst(parent, localName) {
  return descendants(parent, localName)[0] || null;
}

function childText(parent, localName) {
  return firstChild(parent, localName)?.textContent?.trim() || "";
}

function numberAttribute(element, name) {
  const value = Number.parseInt(element.getAttribute(name) || "0", 10);
  return Number.isFinite(value) ? value : 0;
}

function resolveUrl(value, baseUrl) {
  if (!value) {
    return baseUrl;
  }

  return new URL(value, baseUrl).href;
}

function dedupeSegments(segments) {
  const seen = new Set();
  return segments.filter((segment) => {
    const key = `${segment.url}|${segment.range}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function concatenate(chunks, totalBytes) {
  const result = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function setProgress(kind, value, label) {
  const progress = elements[`${kind}Progress`];
  const labelElement = elements[`${kind}Label`];
  if (progress) progress.value = value;
  if (labelElement) labelElement.textContent = label;
  if (kind in overallStage) {
    if (kind === "ffmpeg" && value < overallStage.ffmpeg && value !== 0) {
      return;
    }
    overallStage[kind] = value;
    overallStage.current = kind;
  }
  renderOverallProgress();
}

function renderOverallProgress() {
  if (!elements.progressFill) return;
  const [m0, m1] = STAGE_WEIGHTS.manifest;
  const [v0, v1] = STAGE_WEIGHTS.video;
  const [a0, a1] = STAGE_WEIGHTS.audio;
  const [f0, f1] = STAGE_WEIGHTS.ffmpeg;
  const within = (frac, lo, hi) => lo + Math.max(0, Math.min(1, frac / 100)) * (hi - lo);
  const perItem =
    overallStage.current === "zip" ? Math.max(0, Math.min(100, overallStage.zip)) :
    overallStage.ffmpeg > 0 ? within(overallStage.ffmpeg, f0, f1) :
    overallStage.audio > 0 ? within(overallStage.audio, a0, a1) :
    overallStage.video > 0 ? within(overallStage.video, v0, v1) :
    within(overallStage.manifest, m0, m1);

  const total = state.queueProgressTotal || state.queueTotal || 1;
  const idx = state.queueIndex || 0;
  const serverPct = Math.max(0, Math.min(100, overallStage.ffmpeg));
  const rawPct = state.serverDownloadMode
    ? (total > 1 ? ((idx + serverPct / 100) / total) * 100 : serverPct)
    : ((idx + perItem / 100) / total) * 100;
  const isComplete = state.serverDownloadMode
    ? overallStage.ffmpeg >= 100
    : overallStage.current === "zip"
    ? overallStage.zip >= 100
    : overallStage.ffmpeg >= 100;
  const pct = isComplete ? Math.round(rawPct) : Math.min(99, Math.floor(rawPct));

  elements.progressFill.style.width = `${pct}%`;
  if (elements.progressTrack) elements.progressTrack.setAttribute("aria-valuenow", String(pct));
  if (elements.percentText) elements.percentText.textContent = `${pct}%`;

  const stepKey = state.serverDownloadMode ? "download" : STAGE_TO_STEP[overallStage.current] || "find";
  if (elements.stageText) {
    const labelKey = state.archiveDownloadMode
      ? "stage.downloadVideos"
      : state.serverDownloadMode
      ? "stage.download"
      : STAGE_LABEL_KEYS[overallStage.current] || "stage.preparing";
    const base = t(labelKey);
    const queueSuffix = total > 1 && overallStage.current !== "zip"
      ? ` · ${t("queue.of", { i: Math.min(idx + 1, total), n: total })}`
      : "";
    elements.stageText.textContent = `${base}${queueSuffix}`;
  }
  if (elements.steps) {
    const activeIdx = STEP_ORDER.indexOf(stepKey);
    for (const [i, key] of STEP_ORDER.entries()) {
      const li = elements.steps.querySelector(`li[data-step="${key}"]`);
      if (!li) continue;
      li.classList.toggle("done", i < activeIdx);
      li.classList.toggle("active", i === activeIdx);
    }
  }
}

function markAllDone() {
  if (!elements.steps) return;
  for (const key of STEP_ORDER) {
    const li = elements.steps.querySelector(`li[data-step="${key}"]`);
    if (li) {
      li.classList.add("done");
      li.classList.remove("active");
    }
  }
  if (elements.stageText) elements.stageText.textContent = t("stage.done");
  if (elements.percentText) elements.percentText.textContent = "100%";
  if (elements.progressFill) elements.progressFill.style.width = "100%";
  clearSpeedReadout();
}

function setRuntime(text, mode = "") {
  elements.runtimeStatus.textContent = text;
  elements.runtimeStatus.className = `runtime ${mode}`.trim();
}

function setLog(value) {
  elements.logOutput.textContent = value;
}

function log(message) {
  const timestamp = new Date().toLocaleTimeString([], { hour12: false });
  elements.logOutput.textContent += `[${timestamp}] ${message}\n`;
  elements.logOutput.scrollTop = elements.logOutput.scrollHeight;
}

function sanitizeFilename(value) {
  const cleaned = value.trim().replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, " ");
  const fallback = state.videoId ? `${state.videoId}.mp4` : "kinescope-video.mp4";
  const filename = cleaned || fallback;
  return filename.toLowerCase().endsWith(".mp4") ? filename : `${filename}.mp4`;
}

function formatTrackLabel(track) {
  const size = track.height ? `${track.height}p` : "video";
  const bitrate = track.bandwidth ? `, ${formatBitrate(track.bandwidth)}` : "";
  return `${size}${bitrate}`;
}

function formatBitrate(value) {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)} Mbps`;
  }
  return `${Math.round(value / 1_000)} Kbps`;
}

function formatBytes(value) {
  if (value >= 1_073_741_824) {
    return `${(value / 1_073_741_824).toFixed(2)} GB`;
  }
  if (value >= 1_048_576) {
    return `${(value / 1_048_576).toFixed(1)} MB`;
  }
  if (value >= 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }
  return `${value} B`;
}

function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol);
  } catch {
    return false;
  }
}

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function base64UrlEncode(bytes) {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function base64UrlToBytes(value) {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
