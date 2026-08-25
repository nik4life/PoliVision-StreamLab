const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const ffmpegStatic = require('ffmpeg-static');

let mainWindow;
const processes = new Map();
let detectedEncoder = null;
let startGeneration = 0;

function ffmpegPath() {
  if (!ffmpegStatic) throw new Error('FFmpeg binary was not found.');
  return ffmpegStatic.replace('app.asar', 'app.asar.unpacked');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runProbe(args) {
  return new Promise((resolve) => {
    const child = spawn(ffmpegPath(), args, { windowsHide: true });
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} resolve(false); }, 5000);
    child.once('error', () => { clearTimeout(timer); resolve(false); });
    child.once('exit', (code) => { clearTimeout(timer); resolve(code === 0); });
  });
}

async function detectEncoder(force = false) {
  if (detectedEncoder && !force) return detectedEncoder;
  const candidates = [
    { id: 'nvenc', codec: 'h264_nvenc', label: 'NVIDIA NVENC', hardware: true, args: ['-preset', 'p1', '-tune', 'll', '-rc', 'constqp', '-qp', '28'] },
    { id: 'qsv', codec: 'h264_qsv', label: 'Intel Quick Sync', hardware: true, args: ['-preset', 'veryfast', '-global_quality', '28'] },
    { id: 'amf', codec: 'h264_amf', label: 'AMD AMF', hardware: true, args: ['-quality', 'speed', '-qp_i', '28', '-qp_p', '28'] },
  ];
  for (const candidate of candidates) {
    const ok = await runProbe(['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=size=640x360:rate=25', '-frames:v', '2', '-pix_fmt', 'yuv420p', '-c:v', candidate.codec, ...candidate.args, '-f', 'null', '-']);
    if (ok) { detectedEncoder = candidate; return candidate; }
  }
  detectedEncoder = { id: 'cpu', codec: 'libx264', label: 'x264 (CPU)', hardware: false, args: ['-preset', 'ultrafast', '-tune', 'zerolatency'] };
  return detectedEncoder;
}

function streamUrl(config, index) {
  const auth = config.username ? `${encodeURIComponent(config.username)}:${encodeURIComponent(config.password || '')}@` : '';
  const host = String(config.host || '127.0.0.1').trim();
  const port = Number(config.port || 8554);
  const suffix = String(index).padStart(2, '0');
  return `rtsp://${auth}${host}:${port}/streamlab/cam${suffix}`;
}

function publicStreamUrl(config, index) {
  return streamUrl(config, index).replace(/\/\/.*@/, '//');
}

function stopAll() {
  startGeneration += 1;
  for (const entry of processes.values()) {
    clearTimeout(entry.verifyTimer);
    try { entry.child.kill('SIGTERM'); } catch (_) {}
  }
  processes.clear();
  sendStatus();
}

function statusSnapshot(extra = {}) {
  const entries = Array.from(processes.entries()).sort(([a], [b]) => a - b);
  const active = entries.filter(([, entry]) => entry.state === 'active').map(([index]) => index);
  const starting = entries.filter(([, entry]) => entry.state === 'starting').map(([index]) => index);
  return { running: active.length, starting: starting.length, streams: active, encoder: detectedEncoder, architecture: 'single-encode-mirror', ...extra };
}

function sendStatus(extra = {}) {
  mainWindow?.webContents.send('streamlab:status', statusSnapshot(extra));
}

function encodeArgs(encoder) {
  return ['-c:v', encoder.codec, ...encoder.args, '-pix_fmt', 'yuv420p'];
}

function syntheticArgs(config, encoder) {
  const width = Number(config.width);
  const height = Number(config.height);
  const fps = Number(config.fps);
  return [
    '-hide_banner', '-loglevel', 'warning', '-re',
    '-f', 'lavfi', '-i', `testsrc2=size=${width}x${height}:rate=${fps}`,
    '-an', ...encodeArgs(encoder),
    '-g', String(Math.max(fps * 2, 30)), '-keyint_min', String(Math.max(fps * 2, 30)), '-sc_threshold', '0',
    '-f', 'rtsp', '-rtsp_transport', 'tcp', streamUrl(config, 1),
  ];
}

function fileArgs(config, encoder) {
  const fps = Number(config.fps);
  return [
    '-hide_banner', '-loglevel', 'warning', '-re', '-stream_loop', '-1', '-i', config.filePath,
    '-an', '-vf', `scale=${Number(config.width)}:${Number(config.height)}:force_original_aspect_ratio=decrease,pad=${Number(config.width)}:${Number(config.height)}:(ow-iw)/2:(oh-ih)/2,fps=${fps}`,
    ...encodeArgs(encoder), '-g', String(Math.max(fps * 2, 30)),
    '-f', 'rtsp', '-rtsp_transport', 'tcp', streamUrl(config, 1),
  ];
}

function mirrorArgs(config, index) {
  return [
    '-hide_banner', '-loglevel', 'warning',
    '-rtsp_transport', 'tcp', '-i', streamUrl(config, 1),
    '-map', '0:v:0', '-an', '-c:v', 'copy',
    '-f', 'rtsp', '-rtsp_transport', 'tcp', streamUrl(config, index),
  ];
}

function registerProcess(index, child, failures, encoder, kind) {
  const entry = { child, state: 'starting', verifyTimer: null, kind };
  processes.set(index, entry);
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
    if (stderr.length > 7000) stderr = stderr.slice(-7000);
  });
  entry.verifyTimer = setTimeout(() => {
    if (processes.get(index) === entry && entry.child.exitCode === null) {
      entry.state = 'active';
      sendStatus({ failures, encoder });
    }
  }, kind === 'source' ? 1800 : 1200);
  child.once('exit', (code, signal) => {
    clearTimeout(entry.verifyTimer);
    if (processes.get(index) === entry) processes.delete(index);
    if (code && code !== 0) failures.push({ index, code, signal, message: stderr.trim().slice(-1200) });
    sendStatus({ failures, encoder });
  });
  child.once('error', (error) => {
    clearTimeout(entry.verifyTimer);
    if (processes.get(index) === entry) processes.delete(index);
    failures.push({ index, message: error.message });
    sendStatus({ failures, encoder });
  });
  return entry;
}

async function waitForSource(entry, timeoutMs = 3200) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (entry.child.exitCode !== null) return false;
    if (entry.state === 'active') return true;
    await sleep(100);
  }
  return entry.child.exitCode === null;
}

async function startStreams(config) {
  stopAll();
  const generation = ++startGeneration;
  const count = Math.max(1, Math.min(64, Number(config.count || 1)));
  const binary = ffmpegPath();
  const failures = [];
  const encoder = await detectEncoder();
  sendStatus({ failures, encoder });

  // One real encode session feeds CAM 01. Every additional camera pulls CAM 01
  // from MediaMTX and republishes it with -c copy. This avoids NVENC/QSV/AMF
  // concurrent-session limits and keeps 16/32/64-camera tests lightweight.
  const sourceArgs = config.sourceMode === 'file' ? fileArgs(config, encoder) : syntheticArgs(config, encoder);
  const sourceChild = spawn(binary, sourceArgs, { windowsHide: true });
  const sourceEntry = registerProcess(1, sourceChild, failures, encoder, 'source');

  const sourceReady = await waitForSource(sourceEntry);
  if (generation !== startGeneration) return { ok: false, requested: count, encoder, urls: [] };
  if (!sourceReady) {
    failures.push({ index: 1, message: 'Basisstream CAM 01 konnte nicht veröffentlicht werden.' });
    sendStatus({ failures, encoder });
    return { ok: false, requested: count, encoder, urls: Array.from({ length: count }, (_, i) => publicStreamUrl(config, i + 1)) };
  }

  // Stagger connections so MediaMTX and Windows do not receive a burst of
  // dozens of RTSP handshakes at once. Mirrors do not encode again.
  for (let index = 2; index <= count; index += 1) {
    if (generation !== startGeneration) break;
    await sleep(350);
    if (generation !== startGeneration) break;
    const child = spawn(binary, mirrorArgs(config, index), { windowsHide: true });
    registerProcess(index, child, failures, encoder, 'mirror');
  }

  sendStatus({ failures, encoder });
  return { ok: failures.length === 0, requested: count, encoder, urls: Array.from({ length: count }, (_, i) => publicStreamUrl(config, i + 1)) };
}

function createWindow() {
  mainWindow = new BrowserWindow({ width: 1060, height: 760, minWidth: 850, minHeight: 650, backgroundColor: '#07101d', autoHideMenuBar: true, webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false } });
  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));
}

ipcMain.handle('streamlab:choose-file', async () => {
  const result = await dialog.showOpenDialog(mainWindow, { title: 'Quellvideo auswählen', properties: ['openFile'], filters: [{ name: 'Videos', extensions: ['mp4', 'mkv', 'mov', 'avi', 'webm'] }, { name: 'Alle Dateien', extensions: ['*'] }] });
  return result.canceled ? '' : result.filePaths[0];
});
ipcMain.handle('streamlab:start', (_event, config) => startStreams(config));
ipcMain.handle('streamlab:stop', () => { stopAll(); return true; });
ipcMain.handle('streamlab:get-status', async () => { await detectEncoder(); return statusSnapshot(); });
ipcMain.handle('streamlab:get-encoder', () => detectEncoder());

app.whenReady().then(async () => { createWindow(); await detectEncoder(); sendStatus(); });
app.on('window-all-closed', () => { stopAll(); if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', stopAll);
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
