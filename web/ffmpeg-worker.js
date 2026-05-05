const CORE_URL = "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm/ffmpeg-core.js";

const ERROR_UNKNOWN_MESSAGE_TYPE = new Error("unknown message type");
const ERROR_NOT_LOADED = new Error("ffmpeg is not loaded, call `await ffmpeg.load()` first");
const ERROR_IMPORT_FAILURE = new Error("failed to import ffmpeg-core.js");

const FFMessageType = {
  LOAD: "LOAD",
  EXEC: "EXEC",
  FFPROBE: "FFPROBE",
  WRITE_FILE: "WRITE_FILE",
  READ_FILE: "READ_FILE",
  DELETE_FILE: "DELETE_FILE",
  RENAME: "RENAME",
  CREATE_DIR: "CREATE_DIR",
  LIST_DIR: "LIST_DIR",
  DELETE_DIR: "DELETE_DIR",
  ERROR: "ERROR",
  DOWNLOAD: "DOWNLOAD",
  PROGRESS: "PROGRESS",
  LOG: "LOG",
  MOUNT: "MOUNT",
  UNMOUNT: "UNMOUNT",
};

let ffmpeg;

async function load({ coreURL: requestedCoreURL, wasmURL: requestedWasmURL, workerURL: requestedWorkerURL } = {}) {
  const first = !ffmpeg;
  const coreURL = requestedCoreURL || CORE_URL;
  let importError = null;

  try {
    const coreModule = await import(coreURL);
    self.createFFmpegCore = coreModule.default;
  } catch (error) {
    importError = error;
  }

  if (!self.createFFmpegCore) {
    throw importError || ERROR_IMPORT_FAILURE;
  }

  const wasmURL = requestedWasmURL || coreURL.replace(/.js$/g, ".wasm");
  const workerURL = requestedWorkerURL || coreURL.replace(/.js$/g, ".worker.js");

  ffmpeg = await self.createFFmpegCore({
    mainScriptUrlOrBlob: `${coreURL}#${btoa(JSON.stringify({ wasmURL, workerURL }))}`,
  });
  ffmpeg.setLogger((data) => self.postMessage({ type: FFMessageType.LOG, data }));
  ffmpeg.setProgress((data) => self.postMessage({
    type: FFMessageType.PROGRESS,
    data,
  }));
  return first;
}

function exec({ args, timeout = -1 }) {
  ffmpeg.setTimeout(timeout);
  ffmpeg.exec(...args);
  const ret = ffmpeg.ret;
  ffmpeg.reset();
  return ret;
}

function ffprobe({ args, timeout = -1 }) {
  ffmpeg.setTimeout(timeout);
  ffmpeg.ffprobe(...args);
  const ret = ffmpeg.ret;
  ffmpeg.reset();
  return ret;
}

function writeFile({ path, data }) {
  ffmpeg.FS.writeFile(path, data);
  return true;
}

function readFile({ path, encoding }) {
  return ffmpeg.FS.readFile(path, { encoding });
}

function deleteFile({ path }) {
  ffmpeg.FS.unlink(path);
  return true;
}

function rename({ oldPath, newPath }) {
  ffmpeg.FS.rename(oldPath, newPath);
  return true;
}

function createDir({ path }) {
  ffmpeg.FS.mkdir(path);
  return true;
}

function listDir({ path }) {
  const names = ffmpeg.FS.readdir(path);
  return names.map((name) => {
    const stat = ffmpeg.FS.stat(`${path}/${name}`);
    return { name, isDir: ffmpeg.FS.isDir(stat.mode) };
  });
}

function deleteDir({ path }) {
  ffmpeg.FS.rmdir(path);
  return true;
}

function mount({ fsType, options, mountPoint }) {
  const fs = ffmpeg.FS.filesystems[fsType];
  if (!fs) return false;
  ffmpeg.FS.mount(fs, options, mountPoint);
  return true;
}

function unmount({ mountPoint }) {
  ffmpeg.FS.unmount(mountPoint);
  return true;
}

self.onmessage = async ({ data: { id, type, data: payload } }) => {
  const trans = [];
  let data;

  try {
    if (type !== FFMessageType.LOAD && !ffmpeg) {
      throw ERROR_NOT_LOADED;
    }

    switch (type) {
      case FFMessageType.LOAD:
        data = await load(payload);
        break;
      case FFMessageType.EXEC:
        data = exec(payload);
        break;
      case FFMessageType.FFPROBE:
        data = ffprobe(payload);
        break;
      case FFMessageType.WRITE_FILE:
        data = writeFile(payload);
        break;
      case FFMessageType.READ_FILE:
        data = readFile(payload);
        break;
      case FFMessageType.DELETE_FILE:
        data = deleteFile(payload);
        break;
      case FFMessageType.RENAME:
        data = rename(payload);
        break;
      case FFMessageType.CREATE_DIR:
        data = createDir(payload);
        break;
      case FFMessageType.LIST_DIR:
        data = listDir(payload);
        break;
      case FFMessageType.DELETE_DIR:
        data = deleteDir(payload);
        break;
      case FFMessageType.MOUNT:
        data = mount(payload);
        break;
      case FFMessageType.UNMOUNT:
        data = unmount(payload);
        break;
      default:
        throw ERROR_UNKNOWN_MESSAGE_TYPE;
    }
  } catch (error) {
    self.postMessage({
      id,
      type: FFMessageType.ERROR,
      data: error.toString(),
    });
    return;
  }

  if (data instanceof Uint8Array) {
    trans.push(data.buffer);
  }
  self.postMessage({ id, type, data }, trans);
};
