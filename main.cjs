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
  const entry = processes.get(1);
  const count = Number(entry?.count || 0);
  const running = entry?.state === 'active' ? count : 0;
  const starting = entry?.state === 'starting' ? count : 0;
  return {
    running,
    starting,
    streams: running ? Array.from({ length: count }, (_, i) => i + 1) : [],
    encoder: detectedEncoder,
    architecture: 'single-process-tee',
    ...extra,
  };
}

function sendStatus(extra = {}) {
  mainWindow?.webContents.send('streamlab:status', statusSnapshot(extra));
}

function encodeArgs(encoder) {
  return ['-c:v', encoder.codec, ...encoder.args, '-pix_fmt', 'yuv420p'];
}

function teeTarget(config, index) {
  // One encoded packet stream is duplicated directly to every MediaMTX path.
  // onfail=ignore prevents one failed RTSP destination from terminating all others.
  return `[onfail=ignore:f=rtsp:rtsp_transport=tcp]${streamUrl(config, index)}`;
}

function outputArgs(config, count) {
  const tee = Array.from({ length: count }, (_, i) => teeTarget(config, i + 1)).join('|');
  return ['-map', '0:v:0', '-f', 'tee', tee];
}

function syntheticArgs(config, encoder, count) {
  const width = Number(config.width);
  const height = Number(config.height);
  const fps = Number(config.fps);
  return [
    '-hide_banner', '-loglevel', 'warning', '-re',
    '-f', 'lavfi', '-i', `testsrc2=size=${width}x${height}:rate=${fps}`,
    '-an', ...encodeArgs(encoder),
    '-g', String(Math.max(fps * 2, 30)), '-keyint_min', String(Math.max(fps * 2, 30)), '-sc_threshold', '0',
    ...outputArgs(config, count),
  ];
}

function fileArgs(config, encoder, count) {
  const fps = Number(config.fps);
  return [
    '-hide_banner', '-loglevel', 'warning', '-re', '-stream_loop', '-1', '-i', config.filePath,
    '-an', '-vf', `scale=${Number(config.width)}:${Number(config.height)}:force_original_aspect_ratio=decrease,pad=${Number(config.width)}:${Number(config.height)}:(ow-iw)/2:(oh-ih)/2,fps=${fps}`,
    ...encodeArgs(encoder), '-g', String(Math.max(fps * 2, 30)),
    ...outputArgs(config, count),
  ];
}

function registerProcess(child, count, failures, encoder) {
  const entry = { child, count, state: 'starting', verifyTimer: null };
  processes.set(1, entry);
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
    if (stderr.length > 12000) stderr = stderr.slice(-12000);
  });
  entry.verifyTimer = setTimeout(() => {
    if (processes.get(1) === entry && entry.child.exitCode === null) {
      entry.state = 'active';
      sendStatus({ failures, encoder });
    }
  }, 3500);
  child.once('exit', (code, signal) => {
    clearTimeout(entry.verifyTimer);
    if (processes.get(1) === entry) processes.delete(1);
    if (code && code !== 0) failures.push({ index: 0, code, signal, message: stderr.trim().slice(-3000) });
    sendStatus({ failures, encoder });
  });
  child.once('error', (error) => {
    clearTimeout(entry.verifyTimer);
    if (processes.get(1) === entry) processes.delete(1);
    failures.push({ index: 0, message: error.message });
    sendStatus({ failures, encoder });
  });
  return entry;
}

async function startStreams(config) {
  stopAll();
  const generation = ++startGeneration;
  const count = Math.max(1, Math.min(64, Number(config.count || 1)));
  const failures = [];
  const encoder = await detectEncoder();
  if (generation !== startGeneration) return { ok: false, requested: count, encoder, urls: [] };

  sendStatus({ failures, encoder });

  // Encode once and duplicate the already encoded H.264 packets inside the same
  // FFmpeg process to all RTSP destinations. This removes the previous
  // MediaMTX -> StreamLab -> MediaMTX mirror round-trips, which could saturate a
  // 1-Gbit network with 32 x 4K streams and cause RTP sequence/decode errors.
  const args = config.sourceMode === 'file'
    ? fileArgs(config, encoder, count)
    : syntheticArgs(config, encoder, count);
  const child = spawn(ffmpegPath(), args, { windowsHide: true });
  registerProcess(child, count, failures, encoder);

  return {
    ok: true,
    requested: count,
    encoder,
    architecture: 'single-process-tee',
    urls: Array.from({ length: count }, (_, i) => publicStreamUrl(config, i + 1)),
  };
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
