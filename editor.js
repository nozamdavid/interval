(() => {
  'use strict';

  const $ = id => document.getElementById(id);
  const canvas = $('preview');
  const previewContext = canvas.getContext('2d', { alpha: false });
  const limits = { '16:9': 16 / 9, '9:16': 9 / 16, '1:1': 1, '4:3': 4 / 3 };
  const filenameOrder = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  const state = {
    images: [], index: 0, reference: null, demo: false, crop: null,
    aspect: 'original', turns: 0, angle: 0, fps: 24, repeats: 3,
    cropping: false, playing: false, importing: false, exportController: null,
  };
  const previewCache = new Map();
  let displayImage;
  let displayRequest = 0;
  let playbackRequest;
  let cropGesture;
  let downloadUrl;
  let dragCount = 0;
  let timingBeforeDemo;
  let playbackOffset = 0;
  let thumbnailButtons = [];
  let encoderCheck;
  let projectId;
  let projectDatabase;
  let recentRequest = 0;
  let recentUrls = [];
  let openingFiles = false;
  let reconnecting;

  function onLanding() {
    return $('landing').hidden === false;
  }

  function renderRoute(focus = false) {
    const home = location.hash !== '#editor';
    if (home) {
      pause();
      updateTransport(playbackOffset);
    }
    document.body.classList.toggle('home', home);
    $('landing').hidden = !home;
    for (const id of ['editor-intro', 'workspace', 'export']) $(id).hidden = home;
    if (focus) $(home ? 'landing-heading' : 'editor-heading').focus();
    if (home) void refreshRecent();
    else {
      if (reconnecting) {
        reconnecting = null;
        hideStatus();
      }
      $('recent').hidden = true;
      paintPreview();
    }
  }

  function openEditor() {
    if (!onLanding()) return;
    reconnecting = null;
    hideStatus();
    history.pushState(null, '', '#editor');
    renderRoute(true);
  }

  async function projectStorage(mode, operation) {
    projectDatabase ||= new Promise((resolve, reject) => {
      const request = indexedDB.open('interval-projects', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('projects', { keyPath: 'id' });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const database = await projectDatabase;
    return new Promise((resolve, reject) => {
      const transaction = database.transaction('projects', mode);
      const request = operation(transaction.objectStore('projects'));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onabort = () => reject(transaction.error || request.error);
    });
  }

  async function rememberProject() {
    const first = state.images[0];
    const project = {
      id: projectId ||= crypto.randomUUID(),
      updatedAt: Date.now(),
      thumbnail: first.thumbnail,
      files: state.images.map(({ file, handle }) => ({
        name: file.name, size: file.size, lastModified: file.lastModified, handle,
      })),
    };
    try {
      await projectStorage('readwrite', store => store.put(project));
    } catch (error) {
      if (error?.name !== 'DataCloneError') throw error;
      // A browser may offer handles without supporting persistence for them.
      for (const file of project.files) file.handle = null;
      await projectStorage('readwrite', store => store.put(project));
    }
    if (onLanding()) void refreshRecent();
  }

  async function refreshRecent() {
    const request = ++recentRequest;
    let projects;
    try {
      projects = await projectStorage('readonly', store => store.getAll());
    } catch {
      return;
    }
    if (request !== recentRequest || !onLanding()) return;
    recentUrls.forEach(url => URL.revokeObjectURL(url));
    recentUrls = [];
    const cards = projects.sort((a, b) => b.updatedAt - a.updatedAt).map(project => {
      const name = project.files[0].name;
      const card = document.createElement('li');
      card.className = 'recent-project';
      const open = document.createElement('button');
      open.className = 'recent-open';
      open.type = 'button';
      open.title = name;
      open.addEventListener('click', () => void openProject(project));
      const preview = new Image();
      preview.src = URL.createObjectURL(project.thumbnail);
      recentUrls.push(preview.src);
      preview.alt = '';
      const title = document.createElement('span');
      title.className = 'recent-name';
      title.textContent = name;
      const count = document.createElement('span');
      count.className = 'recent-count';
      count.textContent = `${project.files.length} ${project.files.length === 1 ? 'image' : 'images'}`;
      open.append(preview, title, count);
      const remove = document.createElement('button');
      remove.className = 'icon-button recent-remove';
      remove.type = 'button';
      remove.setAttribute('aria-label', `Remove ${name} from recent projects`);
      remove.title = 'Remove from recent projects';
      remove.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#i-close"/></svg>';
      remove.addEventListener('click', async () => {
        try {
          await projectStorage('readwrite', store => store.delete(project.id));
          if (reconnecting?.project.id === project.id) {
            reconnecting = null;
            hideStatus();
          }
          await refreshRecent();
          ($('recent-projects').querySelector('.recent-open') || $('choose-images')).focus();
        } catch {
          showStatus('Could not remove this project from recent projects.');
        }
      });
      card.append(open, remove);
      return card;
    });
    $('recent-projects').replaceChildren(...cards);
    $('recent').hidden = cards.length === 0;
    updateRecentControls();
  }

  function updateRecentControls() {
    const busy = openingFiles || state.importing || Boolean(state.exportController);
    for (const button of $('recent-projects').querySelectorAll('button')) button.disabled = busy;
  }

  function fileKey({ name, size, lastModified }) {
    return JSON.stringify([name, size, lastModified]);
  }

  function promptReconnect(invalidSelection = false) {
    const { project, entries } = reconnecting;
    const missing = project.files.length - entries.filter(Boolean).length;
    const count = `${missing} original ${missing === 1 ? 'image' : 'images'}`;
    const name = project.files[0].name;
    const message = invalidSelection
      ? `The selection did not match the missing files. Reselect ${count} for ${name}.`
      : `Reselect ${count} to reopen ${name}.`;
    showStatus(message, { reconnect: true });
  }

  async function openProject(project) {
    if (openingFiles || state.importing || state.exportController) return;
    if (project.id === projectId && state.images.length) {
      openEditor();
      return;
    }
    openingFiles = true;
    reconnecting = null;
    updateControls();
    showStatus('Opening project…', { progress: 0 });
    const firstHandle = project.files.find(file => file.handle)?.handle;
    try {
      if (await firstHandle?.queryPermission() === 'prompt') {
        // Chromium can restore access to the site's previously selected files in one prompt.
        await firstHandle.requestPermission();
      }
    } catch {
      // A missing or revoked handle can still be reconnected through the picker.
    }
    const entries = await Promise.all(project.files.map(async ({ handle }) => {
      try {
        return handle ? { file: await handle.getFile(), handle } : null;
      } catch {
        return null;
      }
    }));
    openingFiles = false;
    updateControls();
    if (!onLanding()) {
      hideStatus();
      return;
    }
    if (entries.every(Boolean)) {
      await importFiles(entries, project.id);
    } else {
      reconnecting = { project, entries };
      promptReconnect();
      $('reconnect').focus();
    }
  }

  function acceptSelection(entries, reconnect) {
    if (!entries.length) return;
    if (!reconnect) {
      void importFiles(entries);
      return;
    }
    if (reconnecting !== reconnect) return;
    const candidates = new Map();
    for (const entry of entries) {
      const key = fileKey(entry.file);
      if (!candidates.has(key)) candidates.set(key, []);
      candidates.get(key).push(entry);
    }
    let matched = false;
    reconnect.project.files.forEach((reference, index) => {
      if (reconnect.entries[index]) return;
      const match = candidates.get(fileKey(reference))?.pop();
      if (!match) return;
      reconnect.entries[index] = match;
      matched = true;
    });
    if (reconnect.entries.every(Boolean)) void importFiles(reconnect.entries, reconnect.project.id);
    else promptReconnect(!matched);
  }

  let inputReconnect;
  async function chooseFiles(reconnect = null) {
    if (openingFiles || state.importing || state.exportController) return;
    if (typeof window.showOpenFilePicker === 'function') {
      const wasOnLanding = onLanding();
      openingFiles = true;
      updateControls();
      let entries;
      try {
        const handles = await window.showOpenFilePicker({
          multiple: true,
          types: [{ description: 'Images', accept: { 'image/*': ['.jpg', '.jpeg', '.png', '.webp', '.avif', '.gif', '.bmp', '.tif', '.tiff', '.heic', '.heif'] } }],
        });
        entries = await Promise.all(handles.map(async handle => ({ file: await handle.getFile(), handle })));
      } catch (error) {
        if (error.name !== 'SecurityError') {
          if (error.name !== 'AbortError') showStatus('Could not open the selected images. Try choosing them again.', { reconnect: Boolean(reconnect) });
          return;
        }
      } finally {
        openingFiles = false;
        updateControls();
      }
      if (wasOnLanding !== onLanding()) return;
      if (entries) {
        acceptSelection(entries, reconnect);
        return;
      }
    }
    inputReconnect = reconnect;
    $('files').click();
  }

  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const percent = fraction => `${fraction * 100}%`;

  function frameBounds(project = state) {
    const { width, height } = project.reference;
    return project.turns % 2
      ? { x: 0, y: 0, width: height, height: width }
      : { x: 0, y: 0, width, height };
  }

  function outputSize(crop) {
    const scale = Math.min(1, 3840 / Math.max(crop.width, crop.height));
    const even = value => Math.max(2, Math.round(value * scale / 2) * 2);
    return { width: even(crop.width), height: even(crop.height) };
  }

  function renderImage(context, source, entry, view, project = state) {
    const frame = frameBounds(project);
    const angle = project.angle * Math.PI / 180;
    const sin = Math.sin(angle);
    const cos = Math.cos(angle);
    const centerX = frame.width / 2;
    const centerY = frame.height / 2;
    const turned = project.turns % 2 !== 0;
    const sourceWidth = source.width || source.naturalWidth;
    const sourceHeight = source.height || source.naturalHeight;
    const orientedWidth = turned ? sourceHeight : sourceWidth;
    const orientedHeight = turned ? sourceWidth : sourceHeight;
    let scale = Math.max(frame.width / orientedWidth, frame.height / orientedHeight);
    const crop = project.crop;
    // Measure the crop in the image's rotated coordinate system to keep its edges filled.
    for (const x of [crop.x - centerX, crop.x + crop.width - centerX]) {
      for (const y of [crop.y - centerY, crop.y + crop.height - centerY]) {
        scale = Math.max(scale,
          Math.abs(x * cos + y * sin) * 2 / orientedWidth,
          Math.abs(y * cos - x * sin) * 2 / orientedHeight);
      }
    }
    const width = sourceWidth * scale;
    const height = sourceHeight * scale;

    context.save();
    context.fillStyle = '#111114';
    context.fillRect(0, 0, context.canvas.width, context.canvas.height);
    context.scale(context.canvas.width / view.width, context.canvas.height / view.height);
    context.translate(centerX - view.x, centerY - view.y);
    context.rotate(project.turns * Math.PI / 2 + angle);
    context.imageSmoothingQuality = 'high';
    context.drawImage(source, -width / 2, -height / 2, width, height);
    context.restore();
  }

  async function loadImage(url) {
    const image = new Image();
    image.src = url;
    await image.decode();
    return image;
  }

  async function decodeFile(file) {
    const url = URL.createObjectURL(file);
    try {
      return await loadImage(url);
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  function imageBlob(surface) {
    return new Promise((resolve, reject) => surface.toBlob(blob => {
      if (blob) resolve(blob);
      else reject(new Error('Could not create image preview.'));
    }, 'image/webp', .82));
  }

  function imageVariant(image, maxEdge) {
    const reduced = document.createElement('canvas');
    const factor = Math.min(1, maxEdge / Math.max(image.width, image.height));
    reduced.width = Math.max(1, Math.round(image.width * factor));
    reduced.height = Math.max(1, Math.round(image.height * factor));
    const context = reduced.getContext('2d');
    context.imageSmoothingQuality = 'high';
    context.drawImage(image, 0, 0, reduced.width, reduced.height);
    return imageBlob(reduced);
  }

  function previewSource(entry) {
    const pending = previewCache.get(entry) || loadImage(entry.previewUrl || entry.sourceUrl);
    previewCache.delete(entry);
    previewCache.set(entry, pending);
    if (previewCache.size > 6) previewCache.delete(previewCache.keys().next().value);
    return pending;
  }

  function paintPreview() {
    updateExportButton();
    if (!state.crop || !displayImage) return;
    const { width, height } = outputSize(state.crop);
    $('resolution').textContent = `${width} × ${height}`;
    const view = state.cropping ? frameBounds() : state.crop;
    const stage = $('stage');
    const availableWidth = Math.max(1, stage.clientWidth - (state.cropping ? 36 : 0));
    const availableHeight = Math.max(1, stage.clientHeight - (state.cropping ? 36 : 0));
    const fit = Math.min(availableWidth / view.width, availableHeight / view.height);
    $('image-frame').style.width = `${view.width * fit}px`;
    $('image-frame').style.height = `${view.height * fit}px`;
    const pixelFit = Math.min(1280 / Math.max(view.width, view.height), fit * Math.min(devicePixelRatio, 2));
    const backingWidth = Math.max(1, Math.round(view.width * pixelFit));
    const backingHeight = Math.max(1, Math.round(view.height * pixelFit));
    if (canvas.width !== backingWidth) canvas.width = backingWidth;
    if (canvas.height !== backingHeight) canvas.height = backingHeight;
    renderImage(previewContext, displayImage.source, displayImage.entry, view);
    if (state.cropping) {
      const { x, y, width, height } = state.crop;
      Object.assign($('crop-box').style, {
        left: percent(x / view.width), top: percent(y / view.height),
        width: percent(width / view.width), height: percent(height / view.height),
      });
    }
  }

  async function showCurrent() {
    const request = ++displayRequest;
    const entry = state.images[state.index];
    if (!entry) return;
    try {
      const source = await previewSource(entry);
      if (request !== displayRequest) return;
      displayImage = { source, entry };
      paintPreview();
    } catch {
      if (request !== displayRequest) return;
      pause();
      updateTransport();
      if (!state.exportController) showStatus(`Could not preview ${entry.name}.`);
    }
  }

  function totalDuration() {
    return state.images.length * state.repeats / state.fps;
  }

  function formatTime(time) {
    const tenths = Math.floor(time * 10 + 1e-7);
    const seconds = Math.floor(tenths / 10);
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}.${tenths % 10}`;
  }

  function updateTransport(position = state.index * state.repeats / state.fps) {
    const total = totalDuration();
    const last = state.images.length - 1;
    const frames = state.images.length * state.repeats;
    const playhead = clamp(Math.floor(position * state.fps + 1e-7), 0, frames);
    const scrubber = $('scrubber');
    scrubber.max = Math.max(1, frames);
    scrubber.value = playhead;
    scrubber.disabled = frames < 2;
    scrubber.style.setProperty('--position', percent(frames ? playhead / frames : 0));
    scrubber.setAttribute('aria-valuetext', last < 0 ? 'No images' : `Image ${state.index + 1} of ${last + 1}`);
    $('time').replaceChildren(formatTime(position), Object.assign(document.createElement('span'), { textContent: '/' }), formatTime(total));
    $('duration').value = total ? `${Number(total.toFixed(3))} s` : '0 s';
    $('previous').disabled = state.index === 0;
    $('next').disabled = state.index >= last;
    $('play').disabled = last < 0 || state.cropping;
    const action = state.playing ? 'Pause preview' : 'Play preview';
    $('play').setAttribute('aria-label', action);
    $('play').title = action;
    $('play-icon').setAttribute('href', state.playing ? '#i-pause' : '#i-play');
  }

  function selectFrame(index) {
    if (index === state.index || !state.images[index]) return;
    thumbnailButtons[state.index]?.removeAttribute('aria-current');
    state.index = index;
    const button = thumbnailButtons[index];
    button?.setAttribute('aria-current', 'true');
    if (button) {
      const strip = $('filmstrip');
      const left = button.offsetLeft - strip.offsetLeft;
      if (left < strip.scrollLeft + 10) strip.scrollLeft = left - 12;
      if (left + button.offsetWidth > strip.scrollLeft + strip.clientWidth - 10) {
        strip.scrollLeft = left + button.offsetWidth - strip.clientWidth + 12;
      }
    }
    void showCurrent();
  }

  function seek(index) {
    pause();
    selectFrame(index);
    playbackOffset = state.index * state.repeats / state.fps;
    updateTransport(playbackOffset);
  }

  function pause() {
    cancelAnimationFrame(playbackRequest);
    state.playing = false;
  }

  function play() {
    if (state.playing) {
      pause();
      updateTransport(playbackOffset);
      return;
    }
    const duration = totalDuration();
    if (!duration || state.cropping) return;
    state.playing = true;
    if (playbackOffset >= duration - 1e-7) playbackOffset = 0;
    const started = performance.now() - playbackOffset * 1000;
    const tick = now => {
      playbackOffset = clamp((now - started) / 1000, 0, duration);
      const index = Math.min(state.images.length - 1, Math.floor(playbackOffset * state.fps / state.repeats));
      selectFrame(index);
      if (playbackOffset === duration) pause();
      updateTransport(playbackOffset);
      if (state.playing) playbackRequest = requestAnimationFrame(tick);
    };
    tick(performance.now());
  }

  function renderFilmstrip() {
    const strip = $('filmstrip');
    const fragments = document.createDocumentFragment();
    thumbnailButtons = state.images.map((entry, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'frame-button';
      button.dataset.index = index;
      button.title = entry.name;
      button.setAttribute('aria-label', `Image ${index + 1}: ${entry.name}`);
      if (index === state.index) button.setAttribute('aria-current', 'true');
      const image = new Image();
      image.alt = '';
      image.loading = 'lazy';
      image.src = entry.thumbUrl;
      const number = document.createElement('span');
      number.className = 'frame-number';
      number.textContent = String(index + 1).padStart(2, '0');
      button.append(image, number);
      fragments.append(button);
      return button;
    });
    if (!state.images.length) {
      const empty = document.createElement('p');
      empty.className = 'filmstrip-empty';
      empty.textContent = 'Imported images will appear here.';
      fragments.append(empty);
    }
    strip.replaceChildren(fragments);
    const selected = thumbnailButtons[state.index];
    strip.scrollLeft = selected ? Math.max(0, selected.offsetLeft - strip.offsetLeft - 12) : 0;
  }

  function updateExportButton() {
    const button = $('export');
    if (openingFiles || state.importing || state.exportController || !state.crop) {
      button.disabled = true;
      return;
    }
    const size = outputSize(state.crop);
    const fps = state.fps;
    const key = `${size.width}x${size.height}@${fps}`;
    // Resolve the file format ahead of the click so the picker can use that gesture.
    if (encoderCheck?.key !== key) {
      const check = { key, ready: false };
      encoderCheck = check;
      (async () => {
        try {
          check.encoder = await IntervalMedia.selectEncoder(size, fps);
        } catch (error) {
          check.error = error;
        } finally {
          check.ready = true;
          if (encoderCheck === check) updateExportButton();
        }
      })();
    }
    button.disabled = !encoderCheck.ready;
  }

  function updateControls() {
    const hasImages = state.images.length !== 0;
    const busy = openingFiles || state.importing || Boolean(state.exportController);
    $('import').disabled = busy;
    $('choose-images').disabled = busy;
    $('reconnect').disabled = busy;
    updateRecentControls();
    $('show-demo').disabled = busy;
    $('settings').disabled = busy || !hasImages;
    $('clear').disabled = busy || !hasImages;
    updateExportButton();
    $('crop-done').disabled = busy;
    $('crop-box').inert = busy;
    $('demo-tag').hidden = !state.demo;
    $('sequence-order').hidden = !hasImages || state.demo;
    $('image-count').textContent = `${state.images.length} ${state.images.length === 1 ? 'image' : 'images'}`;
    $('image-frame').hidden = !hasImages;
    $('empty').hidden = hasImages;
    if (!hasImages) $('resolution').textContent = '';
  }

  function syncCropTools() {
    $('aspect').value = state.aspect;
    $('edit-crop').setAttribute('aria-pressed', String(state.cropping));
    $('edit-crop').querySelector('span').textContent = state.cropping ? 'Done cropping' : 'Adjust crop';
    $('crop-box').hidden = !state.cropping;
    $('crop-done').hidden = !state.cropping;
  }

  function syncRotationTools() {
    $('angle').value = state.angle.toFixed(1);
    $('angle-scale').value = state.angle;
  }

  function resetGeometry() {
    state.turns = 0;
    state.angle = 0;
    state.aspect = 'original';
    state.crop = state.reference ? frameBounds() : null;
    state.cropping = false;
    syncCropTools();
    syncRotationTools();
  }

  function releaseImages() {
    for (const entry of state.images) {
      if (entry.previewUrl) URL.revokeObjectURL(entry.previewUrl);
      URL.revokeObjectURL(entry.thumbUrl);
    }
    previewCache.clear();
    displayRequest++;
    displayImage = null;
  }

  function replaceSequence(images, demo) {
    pause();
    releaseImages();
    if (demo && !state.demo) {
      timingBeforeDemo = { fps: state.fps, repeats: state.repeats };
      Object.assign(state, { fps: 24, repeats: 1 });
    } else if (!demo && state.demo) {
      Object.assign(state, timingBeforeDemo);
      timingBeforeDemo = null;
    }
    $('fps').value = state.fps;
    $('repeats').value = state.repeats;
    state.images = images;
    state.demo = demo;
    state.index = 0;
    state.reference = images[0] || null;
    playbackOffset = 0;
    resetGeometry();
    renderFilmstrip();
    updateControls();
    updateTransport();
    void showCurrent();
  }

  function updateProgress(value) {
    const track = $('progress-track');
    $('progress').value = value;
    track.toggleAttribute('data-empty', value === 0);
    track.style.setProperty('--progress', value);
  }

  function showStatus(message, { progress, cancel = false, download = false, reconnect = false } = {}) {
    $('activity').hidden = false;
    $('status').textContent = message;
    $('progress').hidden = progress === undefined;
    $('progress-track').hidden = progress === undefined;
    if (progress !== undefined) updateProgress(progress);
    $('cancel').hidden = !cancel;
    $('download').hidden = !download;
    $('reconnect').hidden = !reconnect;
    $('dismiss').hidden = progress !== undefined;
  }

  function hideStatus() {
    $('activity').hidden = true;
  }

  async function prepareImage({ file, handle }) {
    const bitmap = await globalThis.createImageBitmap?.(file).catch(() => null);
    const image = bitmap || await decodeFile(file);
    try {
      const [preview, thumb] = await Promise.all([imageVariant(image, 1280), imageVariant(image, 196)]);
      return {
        file, handle: await handle, thumbnail: thumb, name: file.name, width: image.width, height: image.height,
        previewUrl: URL.createObjectURL(preview), thumbUrl: URL.createObjectURL(thumb),
      };
    } finally {
      bitmap?.close();
    }
  }

  async function prepareSequence(length, prepare, label) {
    let processed = 0;
    const readingStatus = () => `${label}… (${processed}/${length})`;
    let nextIndex = 0;
    const results = new Array(length);
    const cores = navigator.hardwareConcurrency || 4;
    const memoryLimit = navigator.deviceMemory >= 8 ? 4 : 2;
    const parallelism = Math.min(length, memoryLimit, Math.max(2, Math.floor(cores / 2)));
    const worker = async () => {
      while (nextIndex < length) {
        const index = nextIndex++;
        try {
          results[index] = await prepare(index);
        } catch {
          results[index] = null;
        }
        processed++;
        updateProgress(processed / length);
        $('status').textContent = readingStatus();
      }
    };
    showStatus(readingStatus(), { progress: 0 });
    await Promise.all(Array.from({ length: parallelism }, worker));
    return results;
  }

  async function importFiles(files, restoredId) {
    if (!files.length || openingFiles || state.importing || state.exportController) return;
    if (onLanding()) {
      projectId = restoredId;
      replaceSequence([], false);
      openEditor();
    }
    state.importing = true;
    pause();
    updateControls();
    updateTransport();
    const entries = [];
    const skipped = [];
    try {
      const results = await prepareSequence(files.length, index => prepareImage(files[index]), 'Reading images on this device');
      results.forEach((entry, index) => {
        if (entry) entries.push(entry);
        else skipped.push(files[index].file.name);
      });
      if (restoredId && skipped.length) {
        for (const entry of entries) {
          URL.revokeObjectURL(entry.previewUrl);
          URL.revokeObjectURL(entry.thumbUrl);
        }
        projectId = null;
        showStatus('Could not decode all the original images. The recent project is still available.');
        return;
      }
      if (entries.length && (state.demo || !state.images.length)) {
        replaceSequence(entries.sort((a, b) => filenameOrder.compare(a.name, b.name)), false);
      } else if (entries.length) {
        const selected = state.images[state.index];
        state.images = [...state.images, ...entries].sort((a, b) => filenameOrder.compare(a.name, b.name));
        state.index = state.images.indexOf(selected);
        playbackOffset = state.index * state.repeats / state.fps;
        renderFilmstrip();
        updateTransport();
      }
      if (skipped.length) {
        const detail = skipped.length === 1 ? skipped[0] : `${skipped.length} files`;
        const message = entries.length ? `Imported ${entries.length} images. Could not open ${detail}.` : `Could not open ${detail} as images.`;
        showStatus(`${message} Try JPEG, PNG, or WebP.`);
      } else {
        hideStatus();
      }
      if (entries.length) {
        try {
          await rememberProject();
        } catch {
          showStatus('Images are available in the editor. This browser could not save the project to recents.');
        }
      }
    } finally {
      state.importing = false;
      updateControls();
    }
  }

  async function showDemo() {
    if (openingFiles || state.importing || state.exportController) return;
    openEditor();
    state.importing = true;
    pause();
    updateControls();
    updateTransport();
    try {
      if (!window.IntervalDemoFrames) {
        showStatus('Loading demo images…', { progress: 0 });
        await new Promise((resolve, reject) => {
          const script = document.createElement('script');
          script.src = 'assets/demo-frames.js';
          script.onload = resolve;
          script.onerror = reject;
          document.head.append(script);
        });
      }
      const frames = window.IntervalDemoFrames;
      const entries = await prepareSequence(frames.length, async index => {
        const sourceUrl = frames[index];
        const image = await loadImage(sourceUrl);
        const thumbnail = await imageVariant(image, 196);
        return {
          name: `Demo image ${index + 1}`, sourceUrl, width: image.width, height: image.height,
          thumbUrl: URL.createObjectURL(thumbnail),
        };
      }, 'Loading demo images');
      if (entries.includes(null)) {
        for (const entry of entries) if (entry) URL.revokeObjectURL(entry.thumbUrl);
        throw new Error('A demo frame could not be decoded.');
      }
      hideStatus();
      projectId = null;
      replaceSequence(entries, true);
    } catch {
      showStatus('Could not load the demo. Import your images to start editing.');
    } finally {
      state.importing = false;
      updateControls();
    }
  }

  function applyAspect(aspect) {
    if (!state.crop) return;
    state.aspect = aspect;
    if (aspect !== 'custom') {
      const frame = frameBounds();
      const ratio = limits[aspect];
      const width = ratio ? Math.min(frame.width, frame.height * ratio) : frame.width;
      const height = ratio ? width / ratio : frame.height;
      state.crop = { x: (frame.width - width) / 2, y: (frame.height - height) / 2, width, height };
    } else {
      toggleCrop(true);
    }
    syncCropTools();
    paintPreview();
  }

  function toggleCrop(active) {
    if (!state.crop) return;
    pause();
    state.cropping = active;
    syncCropTools();
    paintPreview();
    updateTransport(playbackOffset);
  }

  function changeCrop(handle, crop, dx, dy) {
    const frame = frameBounds();
    if (handle === 'move') {
      state.crop = {
        ...crop, x: clamp(crop.x + dx, 0, frame.width - crop.width),
        y: clamp(crop.y + dy, 0, frame.height - crop.height),
      };
    } else {
      const west = handle.endsWith('w');
      const north = handle.startsWith('n');
      const anchorX = west ? crop.x + crop.width : crop.x;
      const anchorY = north ? crop.y + crop.height : crop.y;
      const maxWidth = west ? anchorX : frame.width - anchorX;
      const maxHeight = north ? anchorY : frame.height - anchorY;
      const rawWidth = crop.width + dx * (west ? -1 : 1);
      const rawHeight = crop.height + dy * (north ? -1 : 1);
      const ratio = limits[state.aspect];
      const minEdge = Math.min(32, frame.width / 2, frame.height / 2);
      let width = clamp(rawWidth, Math.min(minEdge, maxWidth), maxWidth);
      let height = clamp(rawHeight, Math.min(minEdge, maxHeight), maxHeight);
      if (ratio) {
        const max = Math.min(maxWidth, maxHeight * ratio);
        width = clamp((rawWidth + rawHeight / ratio) / (1 + 1 / ratio ** 2), Math.min(minEdge * Math.max(1, ratio), max), max);
        height = width / ratio;
      }
      state.crop = { x: west ? anchorX - width : anchorX, y: north ? anchorY - height : anchorY, width, height };
    }
    if (state.aspect === 'original') state.aspect = 'custom';
    syncCropTools();
    paintPreview();
  }

  function quarterTurn() {
    const { height } = frameBounds();
    const { x, y, width, height: croppedHeight } = state.crop;
    state.turns = (state.turns + 1) % 4;
    state.crop = { x: Math.max(0, height - y - croppedHeight), y: x, width: croppedHeight, height: width };
  }

  function updateAngle(value, fromScale = false) {
    if (!Number.isFinite(value)) return;
    state.angle = Math.round(clamp(value, -45, 45) * 10) / 10;
    $('angle-scale').value = state.angle;
    if (fromScale) $('angle').value = state.angle.toFixed(1);
    paintPreview();
  }

  async function temporaryExport(extension) {
    const root = await navigator.storage?.getDirectory?.();
    if (!root) throw new Error('This browser cannot save directly to disk. Open Interval in a browser with the File System Access API.');
    const directory = await root.getDirectoryHandle('interval-exports', { create: true });
    const now = Date.now();
    // Leave recent files available to any downloads still using them.
    for await (const name of directory.keys()) {
      const timestamp = Number(/^interval-(\d+)-/.exec(name)?.[1]);
      if (timestamp < now - 24 * 60 * 60 * 1000) {
        await directory.removeEntry(name).catch(() => {});
      }
    }
    const name = `interval-${now}-${crypto.randomUUID()}.${extension}`;
    const handle = await directory.getFileHandle(name, { create: true });
    return { handle, remove: () => directory.removeEntry(name) };
  }

  async function exportVideo() {
    if ($('export').disabled) return;
    pause();
    updateTransport(playbackOffset);
    const controller = new AbortController();
    state.exportController = controller;
    updateControls();
    showStatus('Preparing video…', { progress: 0, cancel: true });
    const project = { ...state, crop: { ...state.crop } };
    const outputCanvas = document.createElement('canvas');
    Object.assign(outputCanvas, outputSize(project.crop));
    const outputContext = outputCanvas.getContext('2d', { alpha: false });
    let destination;
    let temporary;
    let keepTemporary = false;
    try {
      const { encoder, error } = encoderCheck;
      if (!encoder) throw error;
      let handle;
      if (typeof window.showSaveFilePicker === 'function') {
        try {
          const { extension, mimeType } = encoder;
          handle = await window.showSaveFilePicker({
            suggestedName: `interval-timelapse.${extension}`,
            types: [{ description: `${extension.toUpperCase()} video`, accept: { [mimeType]: [`.${extension}`] } }],
          });
        } catch (error) {
          if (error.name !== 'SecurityError') throw error;
        }
      }
      if (!handle) {
        temporary = await temporaryExport(encoder.extension);
        handle = temporary.handle;
      }
      controller.signal.throwIfAborted();
      const format = encoder.extension.toUpperCase();
      const total = project.images.length;
      const reportProgress = processed => showStatus(`Saving ${format} to disk… (${processed}/${total})`, {
        progress: processed / total, cancel: true,
      });
      reportProgress(0);
      destination = await handle.createWritable();
      await IntervalMedia.encode({
        ...encoder, destination,
        canvas: outputCanvas, images: project.images, fps: project.fps, repeats: project.repeats,
        signal: controller.signal,
        async draw(entry) {
          const image = entry.file ? await decodeFile(entry.file) : await loadImage(entry.sourceUrl);
          controller.signal.throwIfAborted();
          renderImage(outputContext, image, entry, project.crop, project);
        },
        onProgress: reportProgress,
      });
      showStatus(`Finishing ${format}… (${total}/${total})`, { progress: 1 });
      await destination.close();
      destination = null;
      if (temporary) {
        const file = await handle.getFile();
        if (downloadUrl) URL.revokeObjectURL(downloadUrl);
        downloadUrl = URL.createObjectURL(file);
        keepTemporary = true;
        $('download').href = downloadUrl;
        $('download').download = `interval-timelapse.${encoder.extension}`;
        $('download').textContent = 'Download video';
        showStatus(`Your ${format} video is ready to download.`, { download: true });
      } else {
        showStatus(`Saved ${handle.name}.`);
      }
    } catch (error) {
      if (controller.signal.aborted || error?.name === 'AbortError') {
        showStatus('Export canceled.');
      } else {
        console.error(error);
        const message = error?.message;
        showStatus(message?.startsWith('This browser') ? message : 'Could not save this video. Check available disk space and file permissions, or try a smaller crop.');
      }
    } finally {
      if (destination) await destination.abort().catch(() => {});
      if (temporary && !keepTemporary) await temporary.remove().catch(() => {});
      state.exportController = null;
      updateControls();
    }
  }

  $('home-link').addEventListener('click', event => {
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    if (!onLanding()) history.back();
  });
  window.addEventListener('popstate', () => renderRoute(true));
  for (const id of ['import', 'choose-images']) $(id).addEventListener('click', () => void chooseFiles());
  $('reconnect').addEventListener('click', () => void chooseFiles(reconnecting));
  $('files').addEventListener('change', event => {
    const files = Array.from(event.currentTarget.files, file => ({ file, handle: null }));
    event.currentTarget.value = '';
    acceptSelection(files, inputReconnect);
    inputReconnect = null;
  });
  $('show-demo').addEventListener('click', showDemo);
  $('clear').addEventListener('click', () => {
    projectId = null;
    hideStatus();
    replaceSequence([], false);
  });
  $('previous').addEventListener('click', () => seek(state.index - 1));
  $('next').addEventListener('click', () => seek(state.index + 1));
  $('play').addEventListener('click', play);
  $('scrubber').addEventListener('input', event => {
    pause();
    const frame = event.target.valueAsNumber;
    selectFrame(Math.min(state.images.length - 1, Math.floor(frame / state.repeats)));
    playbackOffset = frame / state.fps;
    updateTransport(playbackOffset);
  });
  $('filmstrip').addEventListener('click', event => {
    const button = event.target.closest('button[data-index]');
    if (button) seek(Number(button.dataset.index));
  });
  for (const key of ['fps', 'repeats']) {
    $(key).addEventListener('input', event => {
      const input = event.target;
      if (!Number.isFinite(input.valueAsNumber)) return;
      state[key] = clamp(Math.round(input.valueAsNumber), Number(input.min), Number(input.max));
      if (key === 'fps') updateExportButton();
      seek(state.index);
    });
    $(key).addEventListener('change', event => { event.target.value = state[key]; });
  }
  $('aspect').addEventListener('change', event => applyAspect(event.target.value));
  $('reset-crop').addEventListener('click', () => applyAspect('original'));
  $('edit-crop').addEventListener('click', () => toggleCrop(!state.cropping));
  $('crop-done').addEventListener('click', () => {
    toggleCrop(false);
    $('edit-crop').focus();
  });
  $('angle').addEventListener('input', event => updateAngle(event.target.valueAsNumber));
  $('angle').addEventListener('change', syncRotationTools);
  $('angle-scale').addEventListener('input', event => updateAngle(event.target.valueAsNumber, true));
  $('quarter-turn').addEventListener('click', () => {
    quarterTurn();
    if (state.aspect !== 'original' && state.aspect !== '1:1') state.aspect = 'custom';
    syncCropTools();
    paintPreview();
  });
  $('reset-rotation').addEventListener('click', () => {
    const turned = state.turns;
    while (state.turns) quarterTurn();
    if (turned % 2 && state.aspect !== 'original' && state.aspect !== '1:1') state.aspect = 'custom';
    state.angle = 0;
    syncCropTools();
    syncRotationTools();
    paintPreview();
  });
  $('crop-box').addEventListener('pointerdown', event => {
    const handle = event.target.dataset.handle;
    if (!handle || event.button !== 0) return;
    event.preventDefault();
    event.target.focus({ preventScroll: true });
    event.target.setPointerCapture(event.pointerId);
    cropGesture = { handle, pointer: event.pointerId, x: event.clientX, y: event.clientY, crop: { ...state.crop } };
  });
  $('crop-box').addEventListener('pointermove', event => {
    if (event.pointerId !== cropGesture?.pointer) return;
    const frame = frameBounds();
    const rect = $('image-frame').getBoundingClientRect();
    changeCrop(cropGesture.handle, cropGesture.crop,
      (event.clientX - cropGesture.x) * frame.width / rect.width,
      (event.clientY - cropGesture.y) * frame.height / rect.height);
  });
  $('crop-box').addEventListener('lostpointercapture', () => { cropGesture = null; });
  $('crop-box').addEventListener('keydown', event => {
    const directions = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const direction = directions[event.key];
    if (!direction || !event.target.dataset.handle) return;
    event.preventDefault();
    const step = event.shiftKey ? 10 : 1;
    changeCrop(event.target.dataset.handle, state.crop, direction[0] * step, direction[1] * step);
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && state.cropping) {
      toggleCrop(false);
      $('edit-crop').focus();
    }
  });
  $('export').addEventListener('click', exportVideo);
  $('cancel').addEventListener('click', () => state.exportController?.abort());
  $('dismiss').addEventListener('click', () => {
    reconnecting = null;
    hideStatus();
  });
  document.addEventListener('dragenter', event => {
    if (!event.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
    dragCount++;
    if (openingFiles || state.importing || state.exportController) return;
    if (onLanding()) $('landing-drop').setAttribute('data-dragging', '');
    else $('drop-overlay').hidden = false;
  });
  document.addEventListener('dragover', event => {
    if (!event.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = openingFiles || state.importing || state.exportController ? 'none' : 'copy';
  });
  document.addEventListener('dragleave', event => {
    if (!event.dataTransfer.types.includes('Files')) return;
    dragCount = Math.max(0, dragCount - 1);
    if (!dragCount) {
      $('drop-overlay').hidden = true;
      $('landing-drop').removeAttribute('data-dragging');
    }
  });
  document.addEventListener('drop', event => {
    if (!event.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
    dragCount = 0;
    $('drop-overlay').hidden = true;
    $('landing-drop').removeAttribute('data-dragging');
    if (openingFiles || state.importing || state.exportController) return;
    // Capture handles during the drop event, before the browser clears the drag data.
    const entries = Array.from(event.dataTransfer.items).flatMap(item => {
      const file = item.kind === 'file' && item.getAsFile();
      if (!file) return [];
      const handle = item.getAsFileSystemHandle?.().then(handle => handle?.kind === 'file' ? handle : null, () => null);
      return [{ file, handle }];
    });
    void importFiles(entries.length ? entries : Array.from(event.dataTransfer.files, file => ({ file, handle: null })));
  });
  new ResizeObserver(paintPreview).observe($('stage'));
  if (location.hash === '#editor') history.replaceState(null, '', location.pathname + location.search);
  renderRoute();
  updateControls();
  updateTransport();
})();
