import { releaseMetadata } from './releaseMetadata.js';

function createBuildNotice(initialRelease) {
  const notice = document.getElementById('buildNotice');
  const text = document.getElementById('buildNoticeText');
  const notes = document.getElementById('buildNoticeNotes');
  const meta = document.getElementById('buildNoticeMeta');
  const toggle = document.getElementById('buildNoticeToggle');
  const reload = document.getElementById('buildNoticeReload');
  const loadedBuildId = initialRelease.id;
  let displayedRelease = initialRelease;
  let updateAvailable = false;

  function render(release, isUpdate = false) {
    displayedRelease = release;
    updateAvailable = isUpdate;
    const stable = release.status === 'stable';
    notice.dataset.status = release.status;
    notice.dataset.update = String(isUpdate);
    text.replaceChildren();
    const label = document.createElement('b');
    label.textContent = isUpdate
      ? (stable ? 'Stable build available' : 'New candidate available')
      : (stable ? 'Stable build' : 'Candidate build');
    const description = document.createElement('span');
    description.textContent = isUpdate
      ? ` — reload to apply ${release.id}`
      : ` ${release.id} — ${stable ? 'ready' : 'validation in progress'}`;
    text.append(label, description);

    notes.replaceChildren(...release.notes.map((note) => {
      const item = document.createElement('li');
      item.textContent = note;
      return item;
    }));
    const published = new Date(release.publishedAt);
    meta.textContent = `Loaded ${loadedBuildId} · notes ${Number.isNaN(published.valueOf())
      ? release.publishedAt
      : published.toLocaleString()}`;
    reload.hidden = !isUpdate;
    reload.textContent = stable ? 'Reload stable build' : 'Reload candidate';
  }

  function setCollapsed(collapsed) {
    notice.dataset.collapsed = String(collapsed);
    document.getElementById('buildNoticeDetails').hidden = collapsed;
    toggle.textContent = collapsed ? '+' : '−';
    toggle.title = collapsed ? 'Show build notes' : 'Minimize build notes';
    toggle.setAttribute('aria-expanded', String(!collapsed));
  }

  toggle.addEventListener('click', () => {
    setCollapsed(notice.dataset.collapsed !== 'true');
    toggle.blur();
  });
  reload.addEventListener('click', () => location.reload());
  render(initialRelease);

  return {
    announce(nextRelease) {
      if (!nextRelease || nextRelease.id === loadedBuildId) return;
      render(nextRelease, true);
      setCollapsed(false);
    },
    get release() { return displayedRelease; },
    get updateAvailable() { return updateAvailable; },
  };
}

const buildNotice = createBuildNotice(releaseMetadata);
if (import.meta.hot) {
  import.meta.hot.accept('./releaseMetadata.js', (module) => {
    buildNotice.announce(module?.releaseMetadata);
  });
}

function describeGraphicsAdapter() {
  const canvas = document.createElement('canvas');
  const gl = canvas.getContext('webgl2', {
    antialias: false,
    powerPreference: 'high-performance',
  });
  if (!gl) {
    return {
      name: 'WebGL 2 unavailable',
      fullName: 'WebGL 2 unavailable',
      supported: false,
    };
  }
  const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
  const fullName = String(debugInfo
    ? gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL)
    : gl.getParameter(gl.RENDERER));
  const supported = /nvidia|geforce|radeon rx|radeon pro/i.test(fullName)
    && !/swiftshader|llvmpipe|software|intel/i.test(fullName);
  const name = fullName
    .replace(/^ANGLE \(/i, '')
    .replace(/\s+Direct3D.*$/i, '')
    .replace(/\s+vs_\d+_\d+.*$/i, '')
    .replace(/^NVIDIA,\s*/i, '')
    .replace(/^NVIDIA GeForce\s*/i, 'GeForce ')
    .replace(/\s+GPU\b/i, '')
    .replace(/\)+$/, '')
    .trim();
  gl.getExtension('WEBGL_lose_context')?.loseContext();
  return { name: name || fullName, fullName, supported };
}

function showGraphicsGate(adapter) {
  const gate = document.createElement('div');
  gate.id = 'gpuGate';
  gate.setAttribute('role', 'alert');
  gate.innerHTML = `
    <article>
      <h1>Dedicated graphics required</h1>
      <p>GaussianEdit has stopped before loading the scene or AI models.</p>
      <p>Active adapter: <strong></strong></p>
      <p>Choose the dedicated NVIDIA or AMD GPU for this browser in Windows
      Graphics settings, fully restart the browser, then try again.</p>
      <button type="button">Check again</button>
    </article>
  `;
  gate.querySelector('strong').textContent = adapter.name;
  gate.querySelector('button').addEventListener('click', () => location.reload());
  document.body.appendChild(gate);
  document.body.dataset.gpuBlocked = 'true';
  const status = document.getElementById('status');
  if (status) {
    status.textContent = 'dedicated GPU required';
    status.className = '';
  }
  const drop = document.getElementById('drop');
  if (drop) drop.style.display = 'none';
}

const graphicsAdapter = describeGraphicsAdapter();
if (graphicsAdapter.supported) {
  import('./main.js');
} else {
  showGraphicsGate(graphicsAdapter);
}
