const state = {
  count: 1,
  width: 1920,
  height: 1080,
  fps: 25,
  sourceMode: 'synthetic',
  filePath: '',
  requested: 0,
};

const $ = (id) => document.getElementById(id);

function selectButton(containerId, button) {
  document.querySelectorAll(`#${containerId} button`).forEach((item) => item.classList.remove('active'));
  button.classList.add('active');
}

function currentCount() {
  return state.count === 'custom' ? Math.max(1, Math.min(64, Number($('customCount').value || 1))) : Number(state.count);
}

function updatePreview() {
  const host = $('host').value.trim() || '127.0.0.1';
  const port = Number($('port').value || 8554);
  $('previewUrl').textContent = `rtsp://${host}:${port}/streamlab/cam01`;
  updateLoadHint();
}

function updateLoadHint() {
  const count = currentCount();
  const pixelsPerSecond = state.width * state.height * state.fps * count;
  const normalized = pixelsPerSecond / (1920 * 1080 * 25);
  const hint = $('loadHint');

  if (normalized < 8) {
    hint.className = 'load-hint good';
    hint.textContent = `Moderates Testprofil · etwa ${normalized.toFixed(1)}× Full-HD/25-FPS-Last.`;
  } else if (normalized < 32) {
    hint.className = 'load-hint warn';
    hint.textContent = `Hohes Testprofil · etwa ${normalized.toFixed(0)}× Full-HD/25-FPS-Last. CPU-Auslastung beobachten.`;
  } else {
    hint.className = 'load-hint danger';
    hint.textContent = `Extremer Lasttest · etwa ${normalized.toFixed(0)}× Full-HD/25-FPS-Last. Dieses Profil kann den StreamLab-PC vollständig auslasten.`;
  }
}

function config() {
  return {
    host: $('host').value.trim(),
    port: Number($('port').value || 8554),
    username: $('username').value,
    password: $('password').value,
    count: currentCount(),
    width: state.width,
    height: state.height,
    fps: state.fps,
    sourceMode: state.sourceMode,
    filePath: state.filePath,
  };
}

function setRunningStatus(status) {
  const running = Number(status.running || 0);
  const requested = state.requested || running;
  $('runningCount').textContent = `${running} / ${requested}`;
  $('stopButton').disabled = running === 0;
  $('startButton').disabled = running > 0;

  const pill = $('statusPill');
  pill.classList.toggle('online', running > 0);
  pill.querySelector('strong').textContent = running > 0 ? `${running} aktiv` : 'Bereit';

  const failures = status.failures || [];
  if (failures.length) {
    const latest = failures[failures.length - 1];
    $('errorBox').classList.remove('hidden');
    $('errorBox').textContent = `Stream ${latest.index || '?'} konnte nicht gestartet werden: ${latest.message || `FFmpeg Exit ${latest.code}`}`;
  } else if (running > 0) {
    $('errorBox').classList.add('hidden');
  }
}

document.querySelectorAll('#countPresets button').forEach((button) => {
  button.addEventListener('click', () => {
    selectButton('countPresets', button);
    state.count = button.dataset.count;
    $('customCount').classList.toggle('hidden', state.count !== 'custom');
    updateLoadHint();
  });
});

document.querySelectorAll('#resolutionPresets button').forEach((button) => {
  button.addEventListener('click', () => {
    selectButton('resolutionPresets', button);
    state.width = Number(button.dataset.width);
    state.height = Number(button.dataset.height);
    updateLoadHint();
  });
});

document.querySelectorAll('#fpsPresets button').forEach((button) => {
  button.addEventListener('click', () => {
    selectButton('fpsPresets', button);
    state.fps = Number(button.dataset.fps);
    updateLoadHint();
  });
});

document.querySelectorAll('input[name="source"]').forEach((radio) => {
  radio.addEventListener('change', () => {
    state.sourceMode = radio.value;
    document.querySelectorAll('.source-tile').forEach((tile) => tile.classList.toggle('active', tile.contains(radio) && radio.checked));
    $('fileChooser').classList.toggle('hidden', state.sourceMode !== 'file');
  });
});

$('chooseFile').addEventListener('click', async () => {
  const file = await window.streamLab.chooseFile();
  if (!file) return;
  state.filePath = file;
  $('fileName').textContent = file.split(/[\\/]/).pop();
});

$('startButton').addEventListener('click', async () => {
  const next = config();
  if (!next.host) {
    $('errorBox').classList.remove('hidden');
    $('errorBox').textContent = 'Bitte einen RTSP-Server angeben.';
    return;
  }
  if (next.sourceMode === 'file' && !next.filePath) {
    $('errorBox').classList.remove('hidden');
    $('errorBox').textContent = 'Bitte zuerst ein Quellvideo auswählen.';
    return;
  }

  const normalized = (next.width * next.height * next.fps * next.count) / (1920 * 1080 * 25);
  if (normalized >= 32 && !confirm('Dieses Profil erzeugt eine sehr hohe CPU-Last. Wirklich starten?')) return;

  $('errorBox').classList.add('hidden');
  state.requested = next.count;
  $('runningCount').textContent = `0 / ${state.requested}`;
  $('startButton').disabled = true;
  try {
    await window.streamLab.start(next);
  } catch (error) {
    $('startButton').disabled = false;
    $('errorBox').classList.remove('hidden');
    $('errorBox').textContent = error?.message || 'Streams konnten nicht gestartet werden.';
  }
});

$('stopButton').addEventListener('click', async () => {
  await window.streamLab.stop();
  state.requested = 0;
  setRunningStatus({ running: 0 });
});

['host', 'port'].forEach((id) => $(id).addEventListener('input', updatePreview));
$('customCount').addEventListener('input', updateLoadHint);

window.streamLab.onStatus(setRunningStatus);
window.streamLab.getStatus().then(setRunningStatus);
updatePreview();
