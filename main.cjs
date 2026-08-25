const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const ffmpegStatic = require('ffmpeg-static');

let mainWindow;
const processes = new Map();
let detectedEncoder = null;

function ffmpegPath() {
  if (!ffmpegStatic) throw new Error('FFmpeg binary was not found.');
  return ffmpegStatic.replace('app.asar', 'app.asar.unpacked');
}

function runProbe(args) {
  return new Promise((resolve) => {
    const child = spawn(ffmpegPath(), args, { windowsHide: true });
    let stderr = '';
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} resolve(false); }, 5000);
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
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

function stopAll() {
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
  return { running: active.length, starting: starting.length, streams: active, encoder: detectedEncoder, ...extra };
}

function sendStatus(extra = {}) {
  mainWindow?.webContents.send('streamlab:status', statusSnapshot(extra));
}

function encodeArgs(encoder) {
  return ['-c:v', encoder.codec, ...encoder.args, '-pix_fmt', 'yuv420p'];
}

function syntheticArgs(config, index, encoder) {
  const width = Number(config.width);
  const height = Number(config.height);
  const fps = Number(config.fps);
  const name = `CAM ${String(index).padStart(2, '0')}`;
  const fontSize = Math.max(22, Math.round(width / 44));
  const overlay = [
    `drawtext=text='PoliVision StreamLab  ${name}':x=40:y=40:fontsize=${fontSize}:fontcolor=white:box=1:boxcolor=black@0.55`,
    `drawtext=text='${width}x${height}  ${fps} FPS  H.264':x=40:y=90:fontsize=${Math.max(18, fontSize - 8)}:fontcolor=white:box=1:boxcolor=black@0.55`,
    `drawtext=text='%{localtime\\:%H\\:%M\\:%S}':x=w-tw-40:y=40:fontsize=${fontSize}:fontcolor=white:box=1:boxcolor=black@0.55`,
  ].join(',');
  return ['-hide_banner', '-loglevel', 'warning', '-re', '-f', 'lavfi', '-i', `testsrc2=size=${width}x${height}:rate=${fps}`, '-vf', overlay, '-an', ...encodeArgs(encoder), '-g', String(Math.max(fps * 2, 30)), '-keyint_min', String(Math.max(fps * 2, 30)), '-sc_threshold', '0', '-f', 'rtsp', '-rtsp_transport', 'tcp', streamUrl(config, index)];
}

function fileArgs(config, index, encoder) {
  const fps = Number(config.fps);
  return ['-hide_banner', '-loglevel', 'warning', '-re', '-stream_loop', '-1', '-ss', String((index - 1) * 3), '-i', config.filePath, '-an', '-vf', `scale=${Number(config.width)}:${Number(config.height)}:force_original_aspect_ratio=decrease,pad=${Number(config.width)}:${Number(config.height)}:(ow-iw)/2:(oh-ih)/2,fps=${fps}`, ...encodeArgs(encoder), '-g', String(Math.max(fps * 2, 30)), '-f', 'rtsp', '-rtsp_transport', 'tcp', streamUrl(config, index)];
}

async function startStreams(config) {
  stopAll();
  const count = Math.max(1, Math.min(64, Number(config.count || 1)));
  const binary = ffmpegPath();
  const failures = [];
  const encoder = await detectEncoder();
  sendStatus({ failures, encoder });

  for (let index = 1; index <= count; index += 1) {
    const args = config.sourceMode === 'file' ? fileArgs(config, index, encoder) : syntheticArgs(config, index, encoder);
    const child = spawn(binary, args, { windowsHide: true });
    const entry = { child, state: 'starting', verifyTimer: null };
    processes.set(index, entry);
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); if (stderr.length > 5000) stderr = stderr.slice(-5000); });
    entry.verifyTimer = setTimeout(() => {
      if (processes.get(index) === entry && entry.child.exitCode === null) { entry.state = 'active'; sendStatus({ failures, encoder }); }
    }, 1800);
    child.once('exit', (code, signal) => {
      clearTimeout(entry.verifyTimer);
      processes.delete(index);
      if (code && code !== 0) failures.push({ index, code, signal, message: stderr.trim().slice(-900) });
      sendStatus({ failures, encoder });
    });
    child.once('error', (error) => {
      clearTimeout(entry.verifyTimer);
      processes.delete(index);
      failures.push({ index, message: error.message });
      sendStatus({ failures, encoder });
    });
  }

  sendStatus({ failures, encoder });
  return { ok: true, requested: count, encoder, urls: Array.from({ length: count }, (_, i) => streamUrl(config, i + 1).replace(/\/\/.*@/, '//')) };
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
