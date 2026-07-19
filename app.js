(() => {
  'use strict';

  const ESC = '\x1b[';
  const BAYER_4 = [
    [0, 8, 2, 10],
    [12, 4, 14, 6],
    [3, 11, 1, 9],
    [15, 7, 13, 5],
  ];
  const ANSI_16 = [
    [0, 0, 0], [170, 0, 0], [0, 170, 0], [170, 85, 0],
    [0, 0, 170], [170, 0, 170], [0, 170, 170], [170, 170, 170],
    [85, 85, 85], [255, 85, 85], [85, 255, 85], [255, 255, 85],
    [85, 85, 255], [255, 85, 255], [85, 255, 255], [255, 255, 255],
  ];

  const $ = (selector) => document.querySelector(selector);
  const elements = {
    fileInput: $('#fileInput'), dropZone: $('#dropZone'), dropTitle: $('#dropTitle'),
    dropSubtitle: $('#dropSubtitle'), filePill: $('#filePill'), width: $('#widthInput'),
    height: $('#heightInput'), lockRatio: $('#lockRatio'), colorMode: $('#colorMode'),
    fitMode: $('#fitMode'), backgroundMode: $('#backgroundMode'),
    backgroundColor: $('#backgroundColor'), backgroundColorField: $('#backgroundColorField'),
    backgroundColorValue: $('#backgroundColorValue'), dither: $('#ditherToggle'),
    canvas: $('#workCanvas'), preview: $('#ansiPreview'), empty: $('#emptyState'),
    emptyTitle: $('#emptyTitle'), emptySubtitle: $('#emptySubtitle'), terminalStage: $('#terminalStage'),
    zoomValue: $('#zoomValue'), statsDimensions: $('#statDimensions'), statsSize: $('#statSize'),
    statsColors: $('#statColors'), codeOutput: $('#codeOutput'), copy: $('#copyButton'),
    download: $('#downloadButton'), outputNote: $('#outputNote'),
  };

  const state = {
    image: null,
    filename: '',
    rawAnsi: '',
    config: '',
    activeTab: 'config',
    zoom: 1,
    previewRows: [],
  };

  let conversionTimer = null;

  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const readDimension = (input, min, max) => {
    const value = input.valueAsNumber;
    return Number.isInteger(value) && value >= min && value <= max ? value : null;
  };

  function loadFile(file) {
    if (!file || !file.type.startsWith('image/')) {
      showToast('Please choose a valid image file.');
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      const image = new Image();
      image.onload = () => {
        state.image = image;
        state.filename = file.name;
        elements.dropZone.classList.add('has-file');
        elements.dropTitle.textContent = 'Image ready';
        elements.dropSubtitle.textContent = `${image.naturalWidth} × ${image.naturalHeight} pixels`;
        elements.filePill.textContent = file.name;
        elements.filePill.hidden = false;
        syncHeightToRatio();
        convertImage();
      };
      image.onerror = () => showToast('That image could not be decoded.');
      image.src = reader.result;
    };
    reader.onerror = () => showToast('That file could not be read.');
    reader.readAsDataURL(file);
  }

  function syncHeightToRatio() {
    if (!state.image || !elements.lockRatio.checked) return;
    const width = readDimension(elements.width, 8, 160);
    if (width === null) return;
    const ratio = state.image.naturalHeight / state.image.naturalWidth;
    elements.height.value = clamp(Math.round((width * ratio) / 2), 4, 100);
  }

  function syncWidthToRatio() {
    if (!state.image || !elements.lockRatio.checked) return;
    const height = readDimension(elements.height, 4, 100);
    if (height === null) return;
    const ratio = state.image.naturalWidth / state.image.naturalHeight;
    elements.width.value = clamp(Math.round(height * ratio * 2), 8, 160);
  }

  function drawSource(width, rows) {
    const canvas = elements.canvas;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    const pixelHeight = rows * 2;
    canvas.width = width;
    canvas.height = pixelHeight;
    context.clearRect(0, 0, width, pixelHeight);

    if (elements.backgroundMode.value === 'solid') {
      context.fillStyle = elements.backgroundColor.value;
      context.fillRect(0, 0, width, pixelHeight);
    }

    let dx = 0, dy = 0, dw = width, dh = pixelHeight;
    const sourceRatio = state.image.naturalWidth / state.image.naturalHeight;
    const targetRatio = width / pixelHeight;
    const fit = elements.fitMode.value;

    if (fit !== 'stretch') {
      const contain = fit === 'contain';
      if ((sourceRatio > targetRatio) === contain) {
        dh = width / sourceRatio;
        dy = (pixelHeight - dh) / 2;
      } else {
        dw = pixelHeight * sourceRatio;
        dx = (width - dw) / 2;
      }
    }

    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(state.image, dx, dy, dw, dh);
    return context.getImageData(0, 0, width, pixelHeight);
  }

  function quantize(rgb, mode, x, y, dither) {
    let [r, g, b] = rgb;
    if (dither && mode !== 'truecolor') {
      const strength = mode === 'ansi16' ? 34 : mode === 'mono' ? 45 : 10;
      const adjustment = ((BAYER_4[y % 4][x % 4] / 15) - 0.5) * strength;
      r = clamp(Math.round(r + adjustment), 0, 255);
      g = clamp(Math.round(g + adjustment), 0, 255);
      b = clamp(Math.round(b + adjustment), 0, 255);
    }

    if (mode === 'truecolor') return { rgb: [r, g, b], code: `${r};${g};${b}`, index: null };

    if (mode === 'mono') {
      const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      const value = luminance < 128 ? 0 : 255;
      return { rgb: [value, value, value], code: value === 0 ? '0' : '15', index: value === 0 ? 0 : 15 };
    }

    if (mode === 'ansi16') {
      let bestIndex = 0;
      let bestDistance = Infinity;
      ANSI_16.forEach((color, index) => {
        const distance = ((r - color[0]) ** 2) + ((g - color[1]) ** 2) + ((b - color[2]) ** 2);
        if (distance < bestDistance) { bestDistance = distance; bestIndex = index; }
      });
      return { rgb: ANSI_16[bestIndex], code: String(bestIndex), index: bestIndex };
    }

    const toCube = (channel) => Math.round((channel / 255) * 5);
    const ri = toCube(r), gi = toCube(g), bi = toCube(b);
    const cubeIndex = 16 + (36 * ri) + (6 * gi) + bi;
    const cubeRgb = [ri, gi, bi].map((v) => v === 0 ? 0 : 55 + (v * 40));
    const grayAverage = (r + g + b) / 3;
    const grayStep = clamp(Math.round((grayAverage - 8) / 10), 0, 23);
    const grayValue = 8 + grayStep * 10;
    const cubeDistance = cubeRgb.reduce((sum, value, index) => sum + (value - [r, g, b][index]) ** 2, 0);
    const grayDistance = [r, g, b].reduce((sum, value) => sum + (value - grayValue) ** 2, 0);
    const useGray = grayDistance < cubeDistance;
    return useGray
      ? { rgb: [grayValue, grayValue, grayValue], code: String(232 + grayStep), index: 232 + grayStep }
      : { rgb: cubeRgb, code: String(cubeIndex), index: cubeIndex };
  }

  function pixelAt(imageData, x, y, mode, dither) {
    const offset = ((y * imageData.width) + x) * 4;
    const alpha = imageData.data[offset + 3];
    if (alpha < 32) return null;
    return quantize([
      imageData.data[offset], imageData.data[offset + 1], imageData.data[offset + 2],
    ], mode, x, y, dither);
  }

  function colorSequence(color, background, mode) {
    if (!color) return background ? '49' : '39';
    if (mode === 'truecolor') return `${background ? '48' : '38'};2;${color.code}`;
    if (mode === 'xterm256') return `${background ? '48' : '38'};5;${color.code}`;
    const index = color.index;
    if (background) return String(index < 8 ? 40 + index : 100 + index - 8);
    return String(index < 8 ? 30 + index : 90 + index - 8);
  }

  function buildAnsi(imageData, width, rows, mode, dither) {
    const ansiLines = [];
    const previewRows = [];
    const uniqueColors = new Set();

    for (let row = 0; row < rows; row += 1) {
      let line = '';
      const cells = [];
      let previousKey = '';

      for (let x = 0; x < width; x += 1) {
        const upper = pixelAt(imageData, x, row * 2, mode, dither);
        const lower = pixelAt(imageData, x, row * 2 + 1, mode, dither);
        if (upper) uniqueColors.add(upper.rgb.join(','));
        if (lower) uniqueColors.add(lower.rgb.join(','));

        let char = ' ';
        let fg = null;
        let bg = null;
        if (upper && lower) { char = '▀'; fg = upper; bg = lower; }
        else if (upper) { char = '▀'; fg = upper; }
        else if (lower) { char = '▄'; fg = lower; }

        const styleKey = `${fg ? fg.code : '-'}|${bg ? bg.code : '-'}`;
        if (styleKey !== previousKey) {
          line += `${ESC}${colorSequence(fg, false, mode)};${colorSequence(bg, true, mode)}m`;
          previousKey = styleKey;
        }
        line += char;
        cells.push({ char, fg: fg ? fg.rgb : null, bg: bg ? bg.rgb : null });
      }
      ansiLines.push(`${line}${ESC}0m`);
      previewRows.push(cells);
    }

    return { ansi: ansiLines.join('\n'), previewRows, colorCount: uniqueColors.size };
  }

  function buildConfig(rawAnsi) {
    const escapedSource = JSON.stringify(rawAnsi);
    return `"logo": {
  "type": "data-raw",
  "source": ${escapedSource},
  "padding": {
    "right": 2
  }
}`;
  }

  function renderPreview(rows) {
    elements.preview.replaceChildren();
    rows.forEach((row, rowIndex) => {
      row.forEach((cell) => {
        const span = document.createElement('span');
        span.textContent = cell.char;
        if (cell.fg) span.style.color = `rgb(${cell.fg.join(' ')})`;
        if (cell.bg) span.style.backgroundColor = `rgb(${cell.bg.join(' ')})`;
        elements.preview.appendChild(span);
      });
      if (rowIndex < rows.length - 1) elements.preview.appendChild(document.createTextNode('\n'));
    });
    elements.preview.style.transform = `scale(${state.zoom})`;
    elements.preview.hidden = false;
    elements.empty.hidden = true;
  }

  function convertImage() {
    if (!state.image) return;
    const width = readDimension(elements.width, 8, 160);
    const rows = readDimension(elements.height, 4, 100);
    if (width === null || rows === null) {
      clearConversion();
      return;
    }

    const imageData = drawSource(width, rows);
    const result = buildAnsi(imageData, width, rows, elements.colorMode.value, elements.dither.checked);
    state.rawAnsi = result.ansi;
    state.previewRows = result.previewRows;
    state.config = buildConfig(result.ansi);
    renderPreview(result.previewRows);
    updateCodeOutput();

    const bytes = new Blob([result.ansi]).size;
    elements.statsDimensions.textContent = `${width} × ${rows}`;
    elements.statsSize.textContent = formatBytes(bytes);
    elements.statsColors.textContent = result.colorCount.toLocaleString();
    elements.copy.disabled = false;
    elements.download.disabled = false;
  }

  function clearConversion() {
    state.rawAnsi = '';
    state.previewRows = [];
    state.config = '';
    elements.preview.replaceChildren();
    elements.preview.hidden = true;
    elements.emptyTitle.textContent = 'Enter valid dimensions';
    elements.emptySubtitle.textContent = 'Width 8–160 · Height 4–100';
    elements.empty.hidden = false;
    elements.statsDimensions.textContent = '—';
    elements.statsSize.textContent = '—';
    elements.statsColors.textContent = '—';
    elements.codeOutput.textContent = '';
    elements.copy.disabled = true;
    elements.download.disabled = true;
  }

  function scheduleConversion() {
    if (!state.image) return;
    clearTimeout(conversionTimer);
    conversionTimer = setTimeout(() => {
      conversionTimer = null;
      convertImage();
    }, 80);
  }

  function updateCodeOutput() {
    elements.codeOutput.textContent = state.activeTab === 'config' ? state.config : visibleAnsi(state.rawAnsi);
    elements.download.textContent = state.activeTab === 'config' ? 'Download logo.jsonc' : 'Download logo.ansi';
    elements.outputNote.innerHTML = state.activeTab === 'config'
      ? 'Compatible with Fastfetch <code>logo.type: "data-raw"</code>'
      : 'Escape bytes are shown as <code>\\e</code> for readability';
  }

  function visibleAnsi(ansi) {
    return ansi.replaceAll('\x1b', '\\e');
  }

  function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`;
  }

  async function copyOutput() {
    const text = state.activeTab === 'config' ? state.config : state.rawAnsi;
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      const label = elements.copy.querySelector('span');
      label.textContent = 'Copied';
      setTimeout(() => { label.textContent = 'Copy'; }, 1600);
    } catch {
      const textArea = document.createElement('textarea');
      textArea.value = text;
      textArea.style.position = 'fixed';
      textArea.style.opacity = '0';
      document.body.appendChild(textArea);
      textArea.select();
      document.execCommand('copy');
      textArea.remove();
      showToast('Copied to clipboard.');
    }
  }

  function downloadOutput() {
    const configMode = state.activeTab === 'config';
    const content = configMode ? state.config : state.rawAnsi;
    if (!content) return;
    const blob = new Blob([content], { type: configMode ? 'application/json' : 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = configMode ? 'fastfetch-logo.jsonc' : 'fastfetch-logo.ansi';
    anchor.click();
    URL.revokeObjectURL(url);
  }

  function showToast(message) {
    document.querySelector('.toast')?.remove();
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 2600);
  }

  elements.fileInput.addEventListener('change', (event) => loadFile(event.target.files[0]));
  elements.dropZone.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); elements.fileInput.click(); }
  });
  ['dragenter', 'dragover'].forEach((type) => elements.dropZone.addEventListener(type, (event) => {
    event.preventDefault(); elements.dropZone.classList.add('is-dragging');
  }));
  ['dragleave', 'drop'].forEach((type) => elements.dropZone.addEventListener(type, (event) => {
    event.preventDefault(); elements.dropZone.classList.remove('is-dragging');
  }));
  elements.dropZone.addEventListener('drop', (event) => loadFile(event.dataTransfer.files[0]));

  elements.width.addEventListener('input', () => {
    syncHeightToRatio();
    scheduleConversion();
  });
  elements.height.addEventListener('input', () => {
    syncWidthToRatio();
    scheduleConversion();
  });
  elements.lockRatio.addEventListener('change', () => {
    syncHeightToRatio();
    scheduleConversion();
  });
  elements.colorMode.addEventListener('change', scheduleConversion);
  elements.fitMode.addEventListener('change', scheduleConversion);
  elements.dither.addEventListener('change', scheduleConversion);
  elements.backgroundMode.addEventListener('change', () => {
    const solid = elements.backgroundMode.value === 'solid';
    elements.backgroundColor.disabled = !solid;
    elements.backgroundColorField.classList.toggle('is-disabled', !solid);
    scheduleConversion();
  });
  elements.backgroundColor.addEventListener('input', () => {
    elements.backgroundColorValue.value = elements.backgroundColor.value.toUpperCase();
    scheduleConversion();
  });

  document.querySelectorAll('.tab').forEach((tab) => tab.addEventListener('click', () => {
    state.activeTab = tab.dataset.tab;
    document.querySelectorAll('.tab').forEach((button) => {
      const active = button === tab;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-selected', String(active));
    });
    updateCodeOutput();
  }));

  elements.copy.addEventListener('click', copyOutput);
  elements.download.addEventListener('click', downloadOutput);

  $('#decreaseZoom').addEventListener('click', () => {
    state.zoom = clamp(state.zoom - 0.25, 0.5, 2);
    elements.zoomValue.value = `${Math.round(state.zoom * 100)}%`;
    elements.preview.style.transform = `scale(${state.zoom})`;
  });
  $('#increaseZoom').addEventListener('click', () => {
    state.zoom = clamp(state.zoom + 0.25, 0.5, 2);
    elements.zoomValue.value = `${Math.round(state.zoom * 100)}%`;
    elements.preview.style.transform = `scale(${state.zoom})`;
  });

})();
