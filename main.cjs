const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const ffmpegStatic = require('ffmpeg-static');

let mainWindow;
const processes = new Map();

function ffmpegPath() {
  if (!ffmpegStatic) throw new Error('FFmpeg binary was not found.');
  return ffmpegStatic.replace('app.asar', 'app.asar.unpacked');
}

function streamUrl(config, index) {
  const auth = config.username
    ? `${encodeURIComponent(config.username)}:${encodeURIComponent(config.password || '')}@`
    : '';
  const host = String(config.host || '127.0.0.1').trim();
  const port = Number(config.port || 8554);
  const suffix = String(index).padStart(2, '0');
  return `rtsp://${auth}${host}:${port}/streamlab/cam${suffix}`;
}

function stopAll() {
  for (const child of processes.values()) {
    try { child.kill('SIGTERM'); } catch (_) {}
  }
  processes.clear();
  sendStatus();
}

function sendStatus(extra = {}) {
  mainWindow?.webContents.send('streamlab:status', {
    running: processes.size,
    streams: Array.from(processes.keys()).sort((a, b) => a - b),
    ...extra,
  });
}

function syntheticArgs(config, index) {
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

  return [
    '-hide_banner', '-loglevel', 'warning',
    '-re',
    '-f', 'lavfi',
    '-i', `testsrc2=size=${width}x${height}:rate=${fps}`,
    '-vf', overlay,
    '-an',
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-tune', 'zerolatency',
    '-pix_fmt', 'yuv420p',
    '-g', String(Math.max(fps * 2, 30)),
    '-keyint_min', String(Math.max(fps * 2, 30)),
    '-sc_threshold', '0',
    '-f', 'rtsp',
    '-rtsp_transport', 'tcp',
    streamUrl(config, index),
  ];
}

function fileArgs(config, index) {
  const fps = Number(config.fps);
  return [
    '-hide_banner', '-loglevel', 'warning',
    '-re',
    '-stream_loop', '-1',
    '-ss', String((index - 1) * 3),
    '-i', config.filePath,
    '-an',
    '-vf', `scale=${Number(config.width)}:${Number(config.height)}:force_original_aspect_ratio=decrease,pad=${Number(config.width)}:${Number(config.height)}:(ow-iw)/2:(oh-ih)/2,fps=${fps}`,
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-tune', 'zerolatency',
    '-pix_fmt', 'yuv420p',
    '-g', String(Math.max(fps * 2, 30)),
    '-f', 'rtsp',
    '-rtsp_transport', 'tcp',
    streamUrl(config, index),
  ];
}

async function startStreams(config) {
  stopAll();
  const count = Math.max(1, Math.min(64, Number(config.count || 1)));
  const binary = ffmpegPath();
  const failures = [];

  for (let index = 1; index <= count; index += 1) {
    const args = config.sourceMode === 'file' ? fileArgs(config, index) : syntheticArgs(config, index);
    const child = spawn(binary, args, { windowsHide: true });
    processes.set(index, child);

    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 4000) stderr = stderr.slice(-4000);
    });
    child.once('exit', (code, signal) => {
      processes.delete(index);
      if (code && code !== 0) failures.push({ index, code, signal, message: stderr.trim().slice(-700) });
      sendStatus({ failures });
    });
    child.once('error', (error) => {
      processes.delete(index);
      failures.push({ index, message: error.message });
      sendStatus({ failures });
    });
  }

  sendStatus({ failures });
  return {
    ok: true,
    requested: count,
    urls: Array.from({ length: count }, (_, i) => streamUrl(config, i + 1).replace(/\/\/.*@/, '//')),
  };
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1060,
    height: 760,
    minWidth: 850,
    minHeight: 650,
    backgroundColor: '#07101d',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));
}

ipcMain.handle('streamlab:choose-file', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Quellvideo auswählen',
    properties: ['openFile'],
    filters: [
      { name: 'Videos', extensions: ['mp4', 'mkv', 'mov', 'avi', 'webm'] },
      { name: 'Alle Dateien', extensions: ['*'] },
    ],
  });
  return result.canceled ? '' : result.filePaths[0];
});
ipcMain.handle('streamlab:start', (_event, config) => startStreams(config));
ipcMain.handle('streamlab:stop', () => { stopAll(); return true; });
ipcMain.handle('streamlab:get-status', () => ({ running: processes.size, streams: Array.from(processes.keys()) }));

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { stopAll(); if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', stopAll);
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
