const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const ffmpegStatic = require('ffmpeg-static');

let mainWindow;
const processes = new Map();
let detectedEncoder = null;
let startGeneration = 0;
let requestedCount = 0;

function ffmpegPath() {
  if (!ffmpegStatic) throw new Error('FFmpeg binary was not found.');
  return ffmpegStatic.replace('app.asar', 'app.asar.unpacked');
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

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

function publicStreamUrl(config, index) { return streamUrl(config, index).replace(/\/\/.*@/, '//'); }

function stopAll() {
  startGeneration += 1;
  for (const entry of processes.values()) {
    clearTimeout(entry.verifyTimer);
    try { entry.child.stdin?.end(); } catch (_) {}
    try { entry.child.kill('SIGTERM'); } catch (_) {}
  }
  processes.clear();
  requestedCount = 0;
  sendStatus();
}

function statusSnapshot(extra = {}) {
  const publishers = [...processes.entries()].filter(([key]) => String(key).startsWith('pub-'));
  const running = publishers.filter(([, entry]) => entry.state === 'active').length;
  const starting = publishers.filter(([, entry]) => entry.state === 'starting').length;
  return {
    running,
    starting,
    streams: publishers.filter(([, entry]) => entry.state === 'active').map(([, entry]) => entry.index).sort((a, b) => a - b),
    encoder: detectedEncoder,
    architecture: 'single-encode-local-pipe-fanout',
    requested: requestedCount,
    ...extra,
  };
}

function sendStatus(extra = {}) { mainWindow?.webContents.send('streamlab:status', statusSnapshot(extra)); }
function encodeArgs(encoder) { return ['-c:v', encoder.codec, ...encoder.args, '-pix_fmt', 'yuv420p']; }

function syntheticProducerArgs(config, encoder) {
  const width = Number(config.width);
  const height = Number(config.height);
  const fps = Number(config.fps);
  return [
    '-hide_banner', '-loglevel', 'warning', '-re',
    '-f', 'lavfi', '-i', `testsrc2=size=${width}x${height}:rate=${fps}`,
    '-an', ...encodeArgs(encoder),
    '-g', String(Math.max(fps, 15)), '-keyint_min', String(Math.max(fps, 15)), '-sc_threshold', '0',
    '-f', 'mpegts', '-muxdelay', '0', '-muxpreload', '0', 'pipe:1',
  ];
}

function fileProducerArgs(config, encoder) {
  const fps = Number(config.fps);
  return [
    '-hide_banner', '-loglevel', 'warning', '-re', '-stream_loop', '-1', '-i', config.filePath,
    '-an', '-vf', `scale=${Number(config.width)}:${Number(config.height)}:force_original_aspect_ratio=decrease,pad=${Number(config.width)}:${Number(config.height)}:(ow-iw)/2:(oh-ih)/2,fps=${fps}`,
    ...encodeArgs(encoder),
    '-g', String(Math.max(fps, 15)), '-keyint_min', String(Math.max(fps, 15)), '-sc_threshold', '0',
    '-f', 'mpegts', '-muxdelay', '0', '-muxpreload', '0', 'pipe:1',
  ];
}

function publisherArgs(config, index) {
  return [
    '-hide_banner', '-loglevel', 'warning',
    '-fflags', '+genpts+nobuffer', '-flags', 'low_delay',
    '-f', 'mpegts', '-probesize', '32768', '-analyzeduration', '100000', '-i', 'pipe:0',
    '-map', '0:v:0', '-an', '-c:v', 'copy',
    '-muxdelay', '0',
    '-f', 'rtsp', '-rtsp_transport', 'tcp', streamUrl(config, index),
  ];
}

function registerProcess(key, child, failures, encoder, options = {}) {
  const entry = { child, state: 'starting', verifyTimer: null, index: options.index || 0, kind: options.kind || 'publisher', blocked: false, droppedChunks: 0 };
  processes.set(key, entry);
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
    if (stderr.length > 10000) stderr = stderr.slice(-10000);
  });
  entry.verifyTimer = setTimeout(() => {
    if (processes.get(key) === entry && entry.child.exitCode === null) {
      entry.state = 'active';
      sendStatus({ failures, encoder });
    }
  }, entry.kind === 'producer' ? 1000 : 1800);
  child.once('exit', (code, signal) => {
    clearTimeout(entry.verifyTimer);
    if (processes.get(key) === entry) processes.delete(key);
    if (code && code !== 0) failures.push({ index: entry.index || 0, code, signal, message: stderr.trim().slice(-1800) });
    sendStatus({ failures, encoder });
  });
  child.once('error', (error) => {
    clearTimeout(entry.verifyTimer);
    if (processes.get(key) === entry) processes.delete(key);
    failures.push({ index: entry.index || 0, message: error.message });
    sendStatus({ failures, encoder });
  });
  return entry;
}

function wireProducerFanout(producer, failures, encoder) {
  producer.stdout.on('data', (chunk) => {
    for (const [key, entry] of processes.entries()) {
      if (!String(key).startsWith('pub-')) continue;
      if (entry.child.exitCode !== null || !entry.child.stdin || entry.child.stdin.destroyed) continue;
      if (entry.blocked) { entry.droppedChunks += 1; continue; }
      try {
        const ok = entry.child.stdin.write(chunk);
        if (!ok) {
          entry.blocked = true;
          entry.child.stdin.once('drain', () => { entry.blocked = false; });
        }
      } catch (_) {}
    }
  });
  producer.stdout.once('error', (error) => failures.push({ index: 0, message: `Lokaler Fan-out: ${error.message}` }));
  producer.once('exit', () => {
    for (const [key, entry] of processes.entries()) {
      if (String(key).startsWith('pub-')) { try { entry.child.stdin?.end(); } catch (_) {} }
    }
    sendStatus({ failures, encoder });
  });
}

async function startStreams(config) {
  stopAll();
  const generation = ++startGeneration;
  const count = Math.max(1, Math.min(64, Number(config.count || 1)));
  requestedCount = count;
  const failures = [];
  const encoder = await detectEncoder();
  if (generation !== startGeneration) return { ok: false, requested: count, encoder, urls: [] };
  sendStatus({ failures, encoder });

  // One producer encodes exactly once to MPEG-TS on stdout. Node duplicates
  // those bytes locally into one stdin pipe per RTSP publisher. There is no
  // multicast/Hyper-V network hop and no MediaMTX -> StreamLab round-trip.
  for (let index = 1; index <= count; index += 1) {
    if (generation !== startGeneration) break;
    const child = spawn(ffmpegPath(), publisherArgs(config, index), { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
    registerProcess(`pub-${index}`, child, failures, encoder, { index, kind: 'publisher' });
    if (index % 8 === 0) await sleep(60);
  }

  await sleep(180);
  if (generation !== startGeneration) return { ok: false, requested: count, encoder, urls: [] };
  const producerArgs = config.sourceMode === 'file' ? fileProducerArgs(config, encoder) : syntheticProducerArgs(config, encoder);
  const producer = spawn(ffmpegPath(), producerArgs, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  registerProcess('producer', producer, failures, encoder, { kind: 'producer' });
  wireProducerFanout(producer, failures, encoder);

  return {
    ok: true,
    requested: count,
    encoder,
    architecture: 'single-encode-local-pipe-fanout',
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
