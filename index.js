// ═══════════════════════════════════════════
// State
// ═══════════════════════════════════════════
let datasets = [];
let ds = null;           // { name, classes, cmap, images }
let currentCardSize = 235;
let annData = null;
let filteredImgs = [];
let filteredAnnImgs = [];
let loadedMain = 0, loadedAnn = 0;
const BATCH = 40;
const clsFilters = new Set();
let showAnn = true;
let selectMode = false;
const selected = new Set();
let currentPage = 'dataset';
let obMain, obAnn;
let labeledFilter = 'all';

// ═══════════════════════════════════════════
// Loader / Toast / Modal
// ═══════════════════════════════════════════
function showLoader(on, txt = 'Memuat…') {
  document.getElementById('loader-txt').textContent = txt;
  document.getElementById('loader').classList.toggle('hidden', !on);
}
function toast(msg, type = 'ok') {
  const el = document.getElementById('toast');
  el.className = `toast ${type}`;
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 3000);
}
function openModal(id) { document.getElementById(id).classList.add('show'); }
function closeModal(id) { document.getElementById(id).classList.remove('show'); }

// ═══════════════════════════════════════════
// URL ROUTING
// ═══════════════════════════════════════════
function navigate(path, replace = false) {
  if (replace) history.replaceState({}, '', path);
  else history.pushState({}, '', path);
}

window.addEventListener('popstate', () => restoreFromURL(false));

function restoreFromURL(initial = true) {
  const parts = window.location.pathname.replace(/^\//, '').split('/');
  const dsName = parts[0] ? decodeURIComponent(parts[0]) : '';
  const page = parts[1] || 'dataset';
  if (!dsName || dsName === '') {
    if (!initial) { selected.clear(); selectMode = false; ds = null; annData = null; switchView('home-view'); renderHome(); }
    return;
  }
  if (ds && ds.name === dsName) {
    switchPage(page, false);  // already loaded, just switch tab
  } else {
    loadDataset(dsName, page, false); // load then go to page
  }
}

// ═══════════════════════════════════════════
// HTML Partials Loading
// ═══════════════════════════════════════════
async function loadPartials() {
  const pages = ['dataset', 'class', 'annotation', 'annotate2', 'categorize', 'auto', 'update', 'settings'];
  for (const page of pages) {
    const res = await fetch(`/${page}.html?t=${Date.now()}`);
    if (!res.ok) {
      console.error(`Failed to load ${page}.html: ${res.statusText}`);
      continue;
    }
    const html = await res.text();
    const container = document.getElementById(`page-${page}`);
    if (container) {
      container.innerHTML = html;
      // Execute any script tags inside the partial, as innerHTML doesn't run scripts automatically
      const scripts = container.querySelectorAll('script');
      scripts.forEach(oldScript => {
        const newScript = document.createElement('script');
        Array.from(oldScript.attributes).forEach(attr => newScript.setAttribute(attr.name, attr.value));
        newScript.appendChild(document.createTextNode(oldScript.innerHTML));
        oldScript.parentNode.replaceChild(newScript, oldScript);
      });
    }
  }
}

// ═══════════════════════════════════════════
// Init
// ═══════════════════════════════════════════
window.addEventListener('DOMContentLoaded', async () => {
  showLoader(true, 'Loading interface components…');
  try {
    await loadPartials();
  } catch (err) {
    console.error('Error loading partials:', err);
    toast('Gagal memuat komponen UI', 'err');
  }

  setupObservers();
  refreshTagsFilterDropdown();

  // Close dropdowns on click outside
  window.addEventListener('click', (e) => {
    const classWrap = document.getElementById('class-filter-wrap');
    if (classWrap && !classWrap.contains(e.target)) {
      const menu = document.getElementById('class-filter-menu');
      if (menu) menu.classList.remove('show');
    }
    const labeledWrap = document.getElementById('labeled-filter-wrap');
    if (labeledWrap && !labeledWrap.contains(e.target)) {
      const menu = document.getElementById('labeled-filter-menu');
      if (menu) menu.classList.remove('show');
    }
    const tagsWrap = document.getElementById('tags-filter-wrap');
    if (tagsWrap && !tagsWrap.contains(e.target)) {
      const menu = document.getElementById('tags-filter-menu');
      if (menu) menu.classList.remove('show');
    }
  });

  // Always fetch datasets list first (needed even if we deep-link into a dataset)
  fetch('/api/datasets')
    .then(r => r.json())
    .then(d => {
      datasets = d;
      renderHome();
      // Now restore from URL (may trigger loadDataset which needs datasets)
      restoreFromURL(true);
    })
    .catch(() => toast('Gagal memuat dataset list', 'err'))
    .finally(() => showLoader(false));
  showLoader(true, 'Scanning datasets…');
});

function fetchDatasets() {
  showLoader(true, 'Scanning datasets…');
  fetch('/api/datasets')
    .then(r => r.json())
    .then(d => { datasets = d; renderHome(); showLoader(false); })
    .catch(() => { showLoader(false); toast('Gagal memuat dataset', 'err'); });
}

function fetchDatasetsOnly() {
  fetch('/api/datasets').then(r => r.json()).then(d => { datasets = d; renderHome(); }).catch(() => { });
}

// ═══════════════════════════════════════════
// HOME
// ═══════════════════════════════════════════
function renderHome() {
  document.getElementById('ds-badge').textContent = datasets.length;
  const grid = document.getElementById('ds-grid');
  grid.innerHTML = '';
  if (!datasets.length) {
    grid.innerHTML = `<div style="grid-column:1/-1;padding:40px;text-align:center;color:var(--text-muted);border:1px dashed var(--border);border-radius:12px"><h3 style="margin-top:0">Belum ada dataset</h3><p>Buat folder di <code>dataset/</code> dengan subfolder <code>images/</code> dan <code>labels/</code>.</p></div>`;
    return;
  }
  datasets.forEach(d => grid.appendChild(makeDsCard(d)));
}

function makeDsCard(d) {
  const card = document.createElement('div');
  card.className = 'ds-card';
  card.onclick = () => loadDataset(d.name);
  const cmap = buildCmap(d.classes);
  let thumb;
  if (d.preview) {
    const polys = (d.preview.annotations || []).map(a => {
      const pts = a.points.map(p => `${p[0]},${p[1]}`).join(' ');
      const col = cmap[a.class_id]?.color || '#f00';
      return `<polygon points="${pts}" fill="${col}" fill-opacity=".33" stroke="${col}" stroke-width=".005"/>`;
    }).join('');
    thumb = `<div class="ds-img"><img src="/dataset/${enc(d.name)}/images/${enc(d.preview.filename)}"><svg viewBox="0 0 1 1" preserveAspectRatio="none">${polys}</svg></div>`;
  } else {
    thumb = `<div class="ds-no-img">No images</div>`;
  }
  card.innerHTML = `${thumb}
    <div class="ds-info">
      <h3>${esc(d.name)}</h3>
      <div class="ds-cnt">
        <svg viewBox="0 0 24 24" style="width:13px;height:13px;fill:currentColor"><path d="M19,20H5V8H19M19,6H12L10,4H4C2.89,4 2,4.89 2,6V18A2,2 0 0,0 4,20H20A2,2 0 0,0 22,18V8C22,6.89 21.1,6 20,6Z"/></svg>
        ${d.total_images.toLocaleString()} images
      </div>
    </div>`;
  return card;
}

function showHome() {
  selected.clear(); selectMode = false;
  ds = null; annData = null;
  navigate('/');
  switchView('home-view');
  fetchDatasetsOnly();
}

// ═══════════════════════════════════════════
// LOAD DATASET
// ═══════════════════════════════════════════
function loadDataset(name, targetPage = 'dataset', pushNav = true) {
  showLoader(true, `Loading "${name}"…`);

  Promise.all([
    fetch(`/api/dataset/${enc(name)}`).then(r => r.json()),
    fetch(`/api/dataset/${enc(name)}/tags`).then(r => r.json())
  ])
    .then(([data, tagsMapping]) => {
      const images = (data.images || []).map(img => {
        return {
          ...img,
          tags: tagsMapping[img.filename] || []
        };
      });

      ds = { name, classes: data.classes, cmap: buildCmap(data.classes), images: images };
      annData = null;
      selected.clear(); selectMode = false;
      clsFilters.clear();
      activeTagsFilter.clear(); // Reset tag filter when switching dataset
      labeledFilter = 'all'; // Reset labeled filter
      document.getElementById('hdr-srch').value = '';
      document.getElementById('exp-title').textContent = name;
      buildPills();
      buildClassEditor();
      refreshTagsFilterDropdown();
      renderStats(ds.images, 'ds-stats', true);
      renderDist(ds.images, ds.classes, 'ds-dist');
      filteredImgs = [...ds.images];
      clearGrid('ds-grid-inner', 'ds-sentinel');
      loadedMain = 0;
      syncSelUI();
      switchView('explorer-view');
      switchPage(targetPage, pushNav);
      showLoader(false);
      loadBatchMain();
    })
    .catch(e => { showLoader(false); toast(`Error: ${e.message}`, 'err'); });
}

// ═══════════════════════════════════════════
// PAGE SWITCH
// ═══════════════════════════════════════════
function switchPage(p, pushNav = true) {
  currentPage = p;
  ['dataset', 'class', 'annotation', 'annotate2', 'categorize', 'auto', 'update', 'settings'].forEach(n => {
    const el = document.getElementById(`nav-${n}`);
    if (el) el.classList.toggle('active', n === p);
  });
  document.getElementById('page-dataset').style.display = p === 'dataset' ? '' : 'none';
  document.getElementById('page-class').style.display = p === 'class' ? '' : 'none';
  document.getElementById('page-annotation').style.display = p === 'annotation' ? 'flex' : 'none';
  const pa2 = document.getElementById('page-annotate2');
  if (pa2) pa2.style.display = p === 'annotate2' ? 'flex' : 'none';
  document.getElementById('page-categorize').style.display = p === 'categorize' ? '' : 'none';
  document.getElementById('page-auto').style.display = p === 'auto' ? '' : 'none';
  const pup = document.getElementById('page-update');
  if (pup) pup.style.display = p === 'update' ? 'flex' : 'none';
  document.getElementById('page-settings').style.display = p === 'settings' ? '' : 'none';
  const isGrid = p === 'dataset' || p === 'annotation';
  document.getElementById('hdr-srch-wrap').style.display = isGrid ? '' : 'none';
  document.getElementById('ann-toggle').style.display = isGrid ? '' : 'none';
  document.getElementById('sel-toggle').style.display = isGrid ? '' : 'none';
  document.getElementById('filters-bar').style.display = isGrid ? '' : 'none';
  if (!isGrid) { document.getElementById('sel-bar').classList.remove('show'); }

  if (p === 'class') {
    loadTagsManager();
  }
  if (p === 'categorize') {
    initCatPage();
  }
  if (p === 'auto') {
    initAutoPage();
  }
  if (p === 'settings') {
    loadLLMSettings();
  }

  // Update URL
  if (ds) navigate(`/${enc(ds.name)}/${p}`, !pushNav);
  
  if (p === 'annotation' && ds) {
    if (!annData) {
      loadAnnotatePage();
    } else {
      renderStats(annData.images, 'ann-stats', false);
      refreshClassFilterDropdown();
      refreshTagsFilterDropdown();
      applyFilters();
    }
  }
  if (p === 'dataset' && ds) {
    renderStats(ds.images, 'ds-stats', true);
    refreshClassFilterDropdown();
    refreshTagsFilterDropdown();
    applyFilters();
  }
  
  if (p === 'annotate2' && ds) {
    if (annData && annData.images) {
      if (window.initAnn2) initAnn2({ name: ds.name, classes: annData.classes }, annData.images);
    } else {
      Promise.all([
        fetch(`/api/dataset/${enc(ds.name)}/annotate`).then(r => r.json()),
        fetch(`/api/dataset/${enc(ds.name)}/tags`).then(r => r.json())
      ])
        .then(([data, tagsMapping]) => {
          const images = (data.images || []).map(img => {
            return {
              ...img,
              tags: tagsMapping[img.filename] || []
            };
          });
          annData = data;
          annData.images = images;
          if (window.initAnn2) initAnn2({ name: ds.name, classes: data.classes }, images);
        })
        .catch(() => toast('Gagal memuat annotate2', 'err'));
    }
  }
}

function loadAnnotatePage() {
  showLoader(true, 'Memuat folder annotate…');
  Promise.all([
    fetch(`/api/dataset/${enc(ds.name)}/annotate`).then(r => r.json()),
    fetch(`/api/dataset/${enc(ds.name)}/tags`).then(r => r.json())
  ])
    .then(([data, tagsMapping]) => {
      annData = data;
      const images = (data.images || []).map(img => {
        return {
          ...img,
          tags: tagsMapping[img.filename] || []
        };
      });
      annData.images = images;
      renderStats(images, 'ann-stats', false);
      renderDist(images, ds.classes, 'ann-dist');
      filteredAnnImgs = [...images];
      clearGrid('ann-grid-inner', 'ann-sentinel');
      loadedAnn = 0;
      showLoader(false);
      
      refreshClassFilterDropdown();
      refreshTagsFilterDropdown();
      applyFilters();
    })
    .catch((err) => {
      console.error(err);
      showLoader(false);
      toast('Gagal memuat annotate', 'err');
    });
}

// ═══════════════════════════════════════════
// STATS + DISTRIBUTION
// ═══════════════════════════════════════════
function renderStats(images, containerId, showUnlabelled) {
  const total = images.length;
  const labelled = images.filter(i => i.annotations.length > 0).length;

  const el = document.getElementById(containerId);
  if (el) {
    let html = `
      <div class="stat-chip"><div class="stat-n">${total.toLocaleString()}</div><div class="stat-l">Total</div></div>
      <div class="stat-chip"><div class="stat-n">${labelled.toLocaleString()}</div><div class="stat-l">Labelled</div></div>`;
    if (showUnlabelled)
      html += `<div class="stat-chip"><div class="stat-n">${(total - labelled).toLocaleString()}</div><div class="stat-l">Unlabelled</div></div>`;
    el.innerHTML = html;
  }

  const activeStatsId = (currentPage === 'annotation') ? 'ann-stats' : 'ds-stats';
  if (containerId === activeStatsId) {
    const unlabelled = total - labelled;
    updateLabeledFilterMenu(total, labelled, unlabelled);
  }
}

function renderDist(images, classes, containerId) {
  const el = document.getElementById(containerId);
  el.innerHTML = '';
  if (!classes.names.length) return;
  const cnt = {};
  classes.names.forEach((_, i) => cnt[i] = 0);
  images.forEach(img => img.annotations.forEach(a => { cnt[a.class_id] = (cnt[a.class_id] || 0) + 1; }));
  const max = Math.max(1, ...Object.values(cnt));
  classes.names.forEach((name, i) => {
    const col = classes.color[i] || '#f00';
    const c = cnt[i] || 0;
    const pct = (c / max * 100).toFixed(1);
    const div = document.createElement('div');
    div.className = 'dist-item';
    div.innerHTML = `
      <div class="dist-hdr">
        <div class="dist-name"><span class="dist-dot" style="background:${col}"></span><span>${esc(name)}</span></div>
        <span class="dist-cnt">${c.toLocaleString()}</span>
      </div>
      <div class="dist-bg"><div class="dist-fill" style="width:${pct}%;background:${col}"></div></div>`;
    el.appendChild(div);
  });
}

// ═══════════════════════════════════════════
// DROPDOWN FILTER LOGIC (CLASS, LABELED, TAGS)
// ═══════════════════════════════════════════
function toggleClassFilterDropdown(e) {
  e.stopPropagation();
  const labeledMenu = document.getElementById('labeled-filter-menu');
  const tagsMenu = document.getElementById('tags-filter-menu');
  const classMenu = document.getElementById('class-filter-menu');
  if (labeledMenu) labeledMenu.classList.remove('show');
  if (tagsMenu) tagsMenu.classList.remove('show');
  if (classMenu) classMenu.classList.toggle('show');
}

function toggleLabeledFilterDropdown(e) {
  e.stopPropagation();
  const classMenu = document.getElementById('class-filter-menu');
  const tagsMenu = document.getElementById('tags-filter-menu');
  const labeledMenu = document.getElementById('labeled-filter-menu');
  if (classMenu) classMenu.classList.remove('show');
  if (tagsMenu) tagsMenu.classList.remove('show');
  if (labeledMenu) labeledMenu.classList.toggle('show');
}

function setLabeledFilter(val) {
  labeledFilter = val;
  const menu = document.getElementById('labeled-filter-menu');
  if (menu) menu.classList.remove('show');
  if (currentPage === 'annotation') {
    if (annData && annData.images) {
      renderStats(annData.images, 'ann-stats', false);
    }
  } else {
    if (ds && ds.images) {
      renderStats(ds.images, 'ds-stats', true);
    }
  }
  applyFilters();
}

function updateLabeledFilterMenu(total, labelled, unlabelled) {
  const menu = document.getElementById('labeled-filter-menu');
  if (menu) {
    menu.innerHTML = `
      <div class="dropdown-item ${labeledFilter === 'all' ? 'active' : ''}" onclick="setLabeledFilter('all')">
        <input type="radio" name="labeled-filter" ${labeledFilter === 'all' ? 'checked' : ''} style="pointer-events:none; accent-color:var(--accent)">
        <span style="flex:1">Semua (${total.toLocaleString()})</span>
      </div>
      <div class="dropdown-item ${labeledFilter === 'labeled' ? 'active' : ''}" onclick="setLabeledFilter('labeled')">
        <input type="radio" name="labeled-filter" ${labeledFilter === 'labeled' ? 'checked' : ''} style="pointer-events:none; accent-color:var(--accent)">
        <span style="flex:1">Labelled (${labelled.toLocaleString()})</span>
      </div>
      <div class="dropdown-item ${labeledFilter === 'unlabeled' ? 'active' : ''}" onclick="setLabeledFilter('unlabeled')">
        <input type="radio" name="labeled-filter" ${labeledFilter === 'unlabeled' ? 'checked' : ''} style="pointer-events:none; accent-color:var(--accent)">
        <span style="flex:1">Unlabelled (${unlabelled.toLocaleString()})</span>
      </div>
    `;
  }

  const btn = document.getElementById('labeled-filter-btn');
  if (btn) {
    let text = 'LABELED (ALL) ▾';
    if (labeledFilter === 'labeled') {
      text = `LABELED (${labelled.toLocaleString()}) ▾`;
    } else if (labeledFilter === 'unlabeled') {
      text = `UNLABELED (${unlabelled.toLocaleString()}) ▾`;
    } else {
      text = `LABELED (ALL: ${total.toLocaleString()}) ▾`;
    }
    btn.querySelector('span').textContent = text;
  }
}

function refreshClassFilterDropdown() {
  const menu = document.getElementById('class-filter-menu');
  if (!menu || !ds) return;

  menu.innerHTML = '';

  const allActive = clsFilters.size === 0;
  const allItem = document.createElement('div');
  allItem.className = `dropdown-item ${allActive ? 'active' : ''}`;
  allItem.innerHTML = `
    <input type="checkbox" ${allActive ? 'checked' : ''} style="pointer-events:none; accent-color:var(--accent)">
    <span style="flex:1; font-weight:600">Semua Class</span>
  `;
  allItem.onclick = (e) => {
    e.stopPropagation();
    clsFilters.clear();
    refreshClassFilterDropdown();
    applyFilters();
  };
  menu.appendChild(allItem);

  ds.classes.names.forEach((name, id) => {
    const active = clsFilters.has(id);
    const col = ds.classes.color[id] || '#f00';
    const item = document.createElement('div');
    item.className = `dropdown-item ${active ? 'active' : ''}`;
    item.innerHTML = `
      <input type="checkbox" ${active ? 'checked' : ''} style="pointer-events:none; accent-color:var(--accent)">
      <span class="pill-dot" style="background:${col}; margin-right:8px; display:inline-block; width:8px; height:8px; border-radius:50%"></span>
      <span style="flex:1">${esc(name)}</span>
    `;
    item.onclick = (e) => {
      e.stopPropagation();
      if (clsFilters.has(id)) {
        clsFilters.delete(id);
      } else {
        clsFilters.add(id);
      }
      refreshClassFilterDropdown();
      applyFilters();
    };
    menu.appendChild(item);
  });

  const btn = document.getElementById('class-filter-btn');
  if (btn) {
    if (clsFilters.size === 0) {
      btn.querySelector('span').textContent = 'CLASS (ALL) ▾';
    } else {
      btn.querySelector('span').textContent = `CLASS (${clsFilters.size}) ▾`;
    }
  }
}

function buildPills() {
  refreshClassFilterDropdown();
}

function applyFilters() {
  if (!ds) return;
  const isAnn = (currentPage === 'annotation');
  let imgs = isAnn ? (annData ? annData.images : []) : ds.images;

  if (clsFilters.size > 0) {
    imgs = imgs.filter(img => img.annotations.some(a => clsFilters.has(a.class_id)));
  }

  if (labeledFilter === 'labeled') {
    imgs = imgs.filter(img => img.annotations.length > 0);
  } else if (labeledFilter === 'unlabeled') {
    imgs = imgs.filter(img => img.annotations.length === 0);
  }

  if (activeTagsFilter.size > 0) {
    imgs = imgs.filter(img => {
      const imgTags = img.tags || [];
      if (imgTags.length === 0) {
        return activeTagsFilter.has('__untagged__');
      }
      return imgTags.some(t => activeTagsFilter.has(t));
    });
  }

  const q = document.getElementById('hdr-srch').value.toLowerCase().trim();
  if (q) {
    imgs = imgs.filter(img => img.filename.toLowerCase().includes(q));
  }

  if (isAnn) {
    filteredAnnImgs = imgs;
    clearGrid('ann-grid-inner', 'ann-sentinel');
    loadedAnn = 0;
    loadBatchAnn();
  } else {
    filteredImgs = imgs;
    clearGrid('ds-grid-inner', 'ds-sentinel');
    loadedMain = 0;
    loadBatchMain();
  }
}

// ═══════════════════════════════════════════
function zoomGrid(direction) {
  const step = 30;
  const minSize = 115;
  const maxSize = 535;
  currentCardSize = Math.max(minSize, Math.min(maxSize, currentCardSize + direction * step));
  const cols = `repeat(auto-fill, ${currentCardSize}px)`;
  document.querySelectorAll('.img-grid').forEach(el => el.style.gridTemplateColumns = cols);
}

// ANNOTATION TOGGLE
// ═══════════════════════════════════════════
function toggleAnn() {
  showAnn = !showAnn;
  document.querySelectorAll('.ann-overlay').forEach(el => el.style.display = showAnn ? '' : 'none');
  document.getElementById('ann-toggle').classList.toggle('on-ann', showAnn);
}

// ═══════════════════════════════════════════
// SELECT MODE
// ═══════════════════════════════════════════
// drag-select state
let dragSelecting = false;   // true while LMB held in select mode
let dragIntent = null;    // 'add' | 'remove' — locked at drag start
let dragStartCard = null;    // card where drag began
let dragMoved = false;   // true once mouse enters a DIFFERENT card
let lastClickedFn = null;    // for shift-range

function toggleSel() {
  selectMode = !selectMode;
  if (!selectMode) { selected.clear(); lastClickedFn = null; }
  syncSelUI();
}

function syncSelUI() {
  const btn = document.getElementById('sel-toggle');
  btn.classList.toggle('on-sel', selectMode);
  document.getElementById('ds-grid-inner').classList.toggle('select-mode', selectMode);
  document.getElementById('ann-grid-inner').classList.toggle('select-mode', selectMode);
  document.querySelectorAll('.img-card').forEach(c => {
    c.classList.toggle('selected', selected.has(c.dataset.fn));
  });
  updateSelBar();
}

function updateSelBar() {
  const hasAny = selectMode && selected.size > 0;
  document.getElementById('sel-bar').classList.toggle('show', hasAny);
  document.getElementById('sel-lbl').textContent = `${selected.size} dipilih`;
  // Rename works for both single (rename file) and multi (batch rename with base name)
  document.getElementById('rename-btn').disabled = selected.size === 0;
}

// Called by card onclick
function toggleCard(card, e) {
  if (!selectMode) return;
  // If a real drag just finished, this onclick is the artifact of releasing the mouse
  // on the starting card — skip it; drag already handled the state.
  if (dragMoved) { dragMoved = false; return; }
  e && e.preventDefault();

  // ── SHIFT+click: select range ──────────────
  if (e && e.shiftKey && lastClickedFn) {
    const cards = [...document.querySelectorAll('.img-card')];
    const idxA = cards.findIndex(c => c.dataset.fn === lastClickedFn);
    const idxB = cards.indexOf(card);
    if (idxA !== -1 && idxB !== -1) {
      const lo = Math.min(idxA, idxB), hi = Math.max(idxA, idxB);
      for (let i = lo; i <= hi; i++) {
        selected.add(cards[i].dataset.fn);
        cards[i].classList.add('selected');
      }
      updateSelBar();
      return;
    }
  }

  // ── Normal single-click toggle ──────────────
  const fn = card.dataset.fn;
  if (selected.has(fn)) { selected.delete(fn); card.classList.remove('selected'); }
  else { selected.add(fn); card.classList.add('selected'); }
  lastClickedFn = fn;
  updateSelBar();
}

// ── Drag-select ───────────────────────────────
function setupDragSelect() {
  document.addEventListener('mouseup', () => {
    dragSelecting = false;
    dragIntent = null;
    dragStartCard = null;
    // NOTE: we do NOT reset dragMoved here — toggleCard needs it on the
    // upcoming onclick event (which fires after mouseup on same element).
  });
  document.addEventListener('mouseleave', () => {
    dragSelecting = false; dragIntent = null; dragStartCard = null; dragMoved = false;
  });
}

// mousedown on a card — lock drag intent but DON'T toggle yet.
// The actual toggle happens either:
//   a) in onCardEnter when mouse moves to another card (drag), or
//   b) in toggleCard via onclick (single click).
function startDrag(card, e) {
  if (!selectMode || e.shiftKey || e.button !== 0) return;
  dragSelecting = true;
  dragMoved = false;
  dragStartCard = card;
  dragIntent = selected.has(card.dataset.fn) ? 'remove' : 'add';
  e.preventDefault();   // stop text-selection while dragging
}

// mouseenter on a card
function onCardEnter(card) {
  if (!selectMode) return;
  if (dragSelecting) {
    card.style.background = '';   // clear hover tint when dragging
    if (card === dragStartCard) return;   // re-entered start card, skip
    if (!dragMoved) {
      // First time we enter a DIFFERENT card → also apply to the start card
      dragMoved = true;
      applyDragIntent(dragStartCard);
    }
    applyDragIntent(card);
  } else {
    // Hover preview: yellow = will select, red = will deselect
    card.style.background = selected.has(card.dataset.fn)
      ? 'var(--hover-rem)'
      : 'var(--hover-add)';
  }
}

function onCardLeave(card) {
  card.style.background = '';
}

function applyDragIntent(card) {
  if (!card) return;
  const fn = card.dataset.fn;
  if (dragIntent === 'add') {
    selected.add(fn); card.classList.add('selected');
  } else {
    selected.delete(fn); card.classList.remove('selected');
  }
  lastClickedFn = fn;
  updateSelBar();
}

// ═══════════════════════════════════════════
// IMAGE GRID
// ═══════════════════════════════════════════
function clearGrid(gridId, sentId) {
  const grid = document.getElementById(gridId);
  if (!grid) return;
  grid.querySelectorAll('.img-card,.sep').forEach(e => e.remove());
  const sent = document.getElementById(sentId);
  if (sent) sent.style.display = '';
}

function makeCard(imgData, index, urlPrefix) {
  const card = document.createElement('div');
  card.className = 'img-card';
  card.dataset.fn = imgData.filename;
  card.onclick = (e) => toggleCard(card, e);
  card.onmousedown = (e) => startDrag(card, e);
  card.onmouseenter = () => onCardEnter(card);
  card.onmouseleave = () => onCardLeave(card);
  card.draggable = false;
  if (selectMode && selected.has(imgData.filename)) card.classList.add('selected');

  const polys = (imgData.annotations || []).map(a => {
    const info = ds.cmap[a.class_id] || { name: `Class ${a.class_id}`, color: '#f00' };
    const pts = a.points.map(p => `${p[0]},${p[1]}`).join(' ');
    return `<polygon points="${pts}" fill="${info.color}" fill-opacity=".28" stroke="${info.color}" stroke-width=".004"><title>${esc(info.name)}</title></polygon>`;
  }).join('');

  const classBadges = [...new Set((imgData.annotations || []).map(a => a.class_id))].map(cid => {
    const info = ds.cmap[cid] || { name: `Class ${cid}`, color: '#f00' };
    return `<span class="img-tag" style="background:${info.color}18;color:${info.color};border:1px solid ${info.color}28">${esc(info.name)}</span>`;
  });

  const dbTags = (imgData.tags || []).map(t => {
    return `<span style="background:rgba(255,255,255,0.06);color:var(--text-secondary);border:1px solid var(--border);padding:2px 6px;border-radius:4px;font-size:0.65rem;font-weight:600">${esc(t)}</span>`;
  }).join(' ');

  card.innerHTML = `
    <div class="img-thumb">
      <img src="/${urlPrefix}/${enc(imgData.filename)}" loading="lazy" alt="${esc(imgData.filename)}">
      <svg class="ann-overlay" viewBox="0 0 1 1" preserveAspectRatio="none" style="${showAnn ? '' : 'display:none'}">${polys}</svg>
      <div class="chk"><svg viewBox="0 0 24 24"><path d="M9,16.17L4.83,12L3.41,13.41L9,19L21,7L19.59,5.59L9,16.17Z"/></svg></div>
    </div>
    <div class="img-info">
      <div class="img-fn" title="${esc(imgData.filename)}">${esc(imgData.filename)}</div>
      <div class="img-db-tags" style="margin-bottom:8px;display:flex;flex-wrap:wrap;gap:4px;min-height:16px">${dbTags}</div>
      <div class="img-meta">
        <span class="img-idx">#${index + 1}</span>
        <div class="img-tags">${classBadges.length ? classBadges.join('') : '<span class="img-tag no-lbl">No Labels</span>'}</div>
      </div>
    </div>`;
  return card;
}

function renderBatch(imgs, start, end, gridId, sentId, urlPrefix) {
  const grid = document.getElementById(gridId);
  if (!grid) return;
  const sent = document.getElementById(sentId);
  for (let i = start; i < end && i < imgs.length; i++) {
    if (i > 0 && i % 100 === 0) {
      const s = document.createElement('div');
      s.className = 'sep';
      s.innerHTML = `<span>Image ${i + 1} – ${Math.min(i + 100, imgs.length)}</span>`;
      grid.insertBefore(s, sent);
    }
    grid.insertBefore(makeCard(imgs[i], i, urlPrefix), sent);
  }
}

function loadBatchMain() {
  setSentinelState('ds-spin', 'ds-sent-txt', loadedMain < filteredImgs.length);
  if (!ds || loadedMain >= filteredImgs.length) {
    const txt = document.getElementById('ds-sent-txt');
    if (txt) txt.textContent = filteredImgs.length > 0 ? 'Semua gambar dimuat ✓' : 'Tidak ada gambar';
    return;
  }
  const end = Math.min(loadedMain + BATCH, filteredImgs.length);
  renderBatch(filteredImgs, loadedMain, end, 'ds-grid-inner', 'ds-sentinel', `dataset/${enc(ds.name)}/images`);
  loadedMain = end;
  setSentinelState('ds-spin', 'ds-sent-txt', loadedMain < filteredImgs.length);
}

function loadBatchAnn() {
  if (!annData || loadedAnn >= filteredAnnImgs.length) {
    const txt = document.getElementById('ann-sent-txt');
    if (txt) txt.textContent = filteredAnnImgs.length > 0 ? 'Semua gambar dimuat ✓' : 'Folder annotate kosong';
    return;
  }
  const end = Math.min(loadedAnn + BATCH, filteredAnnImgs.length);
  renderBatch(filteredAnnImgs, loadedAnn, end, 'ann-grid-inner', 'ann-sentinel', `dataset/${enc(ds.name)}/annotate/images`);
  loadedAnn = end;
  if (loadedAnn >= filteredAnnImgs.length) {
    const txt = document.getElementById('ann-sent-txt');
    if (txt) txt.textContent = 'Semua gambar dimuat ✓';
  }
}

function setSentinelState(spinId, txtId, loading) {
  const spin = document.getElementById(spinId);
  if (spin) spin.style.display = loading ? '' : 'none';
}

function setupObservers() {
  const mainSent = document.getElementById('ds-sentinel');
  if (mainSent) {
    obMain = new IntersectionObserver(e => {
      if (e[0].isIntersecting && ds && currentPage === 'dataset') loadBatchMain();
    }, { rootMargin: '400px' });
    obMain.observe(mainSent);
  }

  const annSent = document.getElementById('ann-sentinel');
  if (annSent) {
    obAnn = new IntersectionObserver(e => {
      if (e[0].isIntersecting && annData && currentPage === 'annotation') loadBatchAnn();
    }, { rootMargin: '400px' });
    obAnn.observe(annSent);
  }

  setupDragSelect();
}

// ═══════════════════════════════════════════
// CLASS SETTINGS
// ═══════════════════════════════════════════
function buildClassEditor() {
  if (!ds) return;
  const list = document.getElementById('cls-list');
  if (!list) return;
  list.innerHTML = '';
  ds.classes.names.forEach((name, i) => {
    const col = ds.classes.color[i] || '#f00';
    const row = document.createElement('div');
    row.className = 'cls-row';
    row.dataset.i = i;
    row.innerHTML = `
      <span class="cls-idx">#${i}</span>
      <input class="cls-name-inp" type="text" value="${esc(name)}" placeholder="class name">
      <div class="col-wrap" style="background:${col}">
        <input class="col-inp" type="color" value="${col}">
      </div>
      <button class="btn btn-ghost" style="padding: 4px; color: var(--danger)" onclick="deleteClass(${i})">
        <svg viewBox="0 0 24 24" style="width:16px;height:16px;fill:currentColor"><path d="M19,4H15.5L14.5,3H9.5L8.5,4H5V6H19M6,19A2,2 0 0,0 8,21H16A2,2 0 0,0 18,19V7H6V19Z"/></svg>
      </button>`;
    row.querySelector('.col-inp').addEventListener('input', e => {
      row.querySelector('.col-wrap').style.background = e.target.value;
    });
    list.appendChild(row);
  });
}

function saveClasses() {
  const btn = document.getElementById('save-btn');
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner"></span> Menyimpan…`;
  const names = [], colors = [];
  const rows = document.querySelectorAll('#cls-list .cls-row');
  console.log("saveClasses: found rows in #cls-list", rows.length);
  rows.forEach(r => {
    const nameInp = r.querySelector('.cls-name-inp');
    const colInp = r.querySelector('.col-inp');
    console.log("Processing row:", r, "nameInp:", nameInp, "colInp:", colInp);
    names.push((nameInp ? nameInp.value.trim() : "") || `class_${r.dataset.i}`);
    colors.push(colInp ? colInp.value : "#000000");
  });
  fetch(`/api/dataset/${enc(ds.name)}/classes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ names, color: colors })
  })
    .then(r => r.json())
    .then(d => {
      if (!d.success) throw new Error(d.error);
      ds.classes.names = names; ds.classes.color = colors;
      ds.cmap = buildCmap(ds.classes);
      toast('YAML berhasil disimpan!');
      buildPills();
      renderDist(ds.images, ds.classes, 'ds-dist');
      btn.disabled = false; btn.textContent = 'Simpan YAML Config';
    })
    .catch(e => { toast(`Error: ${e.message}`, 'err'); btn.disabled = false; btn.textContent = 'Simpan YAML Config'; });
}

// ═══════════════════════════════════════════
// SELECTION ACTIONS
// ═══════════════════════════════════════════
function doDelete() {
  if (!selected.size) return;
  const fns = [...selected];
  document.getElementById('confirm-title').textContent = 'Hapus Gambar';
  document.getElementById('confirm-body').textContent = `Hapus ${fns.length} gambar beserta labelnya secara permanen? Tindakan ini tidak dapat dibatalkan.`;
  const okBtn = document.getElementById('confirm-ok');
  okBtn.className = 'btn btn-danger';
  okBtn.textContent = 'Hapus';
  openModal('confirm-modal');
  okBtn.onclick = () => {
    closeModal('confirm-modal');
    showLoader(true, 'Menghapus…');
    fetch(`/api/dataset/${enc(ds.name)}/delete`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filenames: fns })
    })
      .then(r => r.json())
      .then(d => {
        showLoader(false);
        const del = new Set(d.deleted);
        ds.images = ds.images.filter(img => !del.has(img.filename));
        selected.clear(); syncSelUI();
        renderStats(ds.images, 'ds-stats', true);
        renderDist(ds.images, ds.classes, 'ds-dist');
        refreshTagsFilterDropdown();
        applyFilters();
        toast(`${d.deleted.length} gambar dihapus`);
        if (d.errors.length) toast(`${d.errors.length} error`, 'err');
      })
      .catch(e => { showLoader(false); toast(`Error: ${e.message}`, 'err'); });
  };
}

function doRename() {
  if (!selected.size) return;
  const fns = [...selected];
  const isSingle = fns.length === 1;

  // ── Modal setup ──
  const title = document.getElementById('rename-title');
  const desc = document.getElementById('rename-desc');
  const inp = document.getElementById('rename-inp');
  const preview = document.getElementById('rename-preview');
  const okBtn = document.getElementById('rename-ok');
  const addBtn = document.getElementById('rename-add');

  if (isSingle) {
    title.textContent = 'Rename Image';
    desc.textContent = 'Masukkan nama baru (ekstensi dipertahankan otomatis).';
    inp.placeholder = 'nama_file_baru';
    inp.value = fns[0].replace(/\.[^/.]+$/, '');
  } else {
    title.textContent = `Batch Rename — ${fns.length} gambar`;
    desc.textContent = 'Rename (overwrite seluruh nama) atau Add Name (tambah prefix di depan).';
    inp.placeholder = 'nama_dasar / prefix';
    inp.value = '';
  }

  preview.style.display = 'block';
  preview.innerHTML = 'Preview:<br><span style="color:var(--text-muted)">Ketik nama dasar di atas...</span>';

  // Live preview for both modes
  inp.oninput = () => {
    const base = inp.value.trim();
    if (!base) {
      preview.innerHTML = 'Preview:<br><span style="color:var(--text-muted)">Ketik nama dasar di atas...</span>';
      return;
    }

    // Sample for Rename
    let renameText = '';
    if (isSingle) {
      const ext = fns[0].match(/\.[^/.]+$/)?.[0] || '';
      renameText = `${base}${ext}`;
    } else {
      const samples = fns.slice(0, 3).map((f, i) => {
        const ext = f.match(/\.[^/.]+$/)?.[0] || '';
        return `${base}_${i}${ext}`;
      });
      renameText = samples.join(', ') + (fns.length > 3 ? ' ...' : '');
    }

    // Sample for Add Name (Prefix)
    const addNameSamples = fns.slice(0, isSingle ? 1 : 3).map((f, i) => {
      const ext = f.match(/\.[^/.]+$/)?.[0] || '';
      const orig = f.replace(/\.[^/.]+$/, '');
      return `${base}_${i}_${orig}${ext}`;
    });
    let addNameText = addNameSamples.join(', ') + (!isSingle && fns.length > 3 ? ' ...' : '');

    preview.innerHTML = `
      <div style="margin-top: 8px; font-size: 0.82rem;">
        <span style="color:var(--text-secondary); font-weight:600">Rename:</span> <code style="color:var(--accent-light)">${esc(renameText)}</code>
      </div>
      <div style="margin-top: 4px; font-size: 0.82rem;">
        <span style="color:var(--text-secondary); font-weight:600">Add Name:</span> <code style="color:var(--accent-light)">${esc(addNameText)}</code>
      </div>
    `;
  };

  openModal('rename-modal');

  const submitRename = (mode) => {
    const baseName = inp.value.trim();
    if (!baseName) { toast('Nama tidak boleh kosong', 'err'); return; }
    closeModal('rename-modal');

    if (isSingle && mode === "overwrite") {
      // ── Single standard rename (overwrite) ──
      const oldFn = fns[0];
      showLoader(true, 'Renaming…');
      fetch(`/api/dataset/${enc(ds.name)}/rename`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ old_filename: oldFn, new_filename: baseName })
      })
        .then(r => r.json())
        .then(d => {
          showLoader(false);
          if (!d.success) throw new Error(d.detail || 'Rename gagal');
          const img = ds.images.find(i => i.filename === oldFn);
          if (img) img.filename = d.new_filename;
          selected.delete(oldFn); selected.add(d.new_filename);
          filteredImgs = [...ds.images];
          clearGrid('ds-grid-inner', 'ds-sentinel'); loadedMain = 0; loadBatchMain();
          toast(`Renamed ke "${d.new_filename}"`);
        })
        .catch(e => { showLoader(false); toast(`Error: ${e.message}`, 'err'); });
    } else {
      // ── Batch rename / Single rename with prefix ──
      showLoader(true, `Renaming ${fns.length} gambar…`);
      fetch(`/api/dataset/${enc(ds.name)}/rename-batch`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ base_name: baseName, filenames: fns, mode: mode })
      })
        .then(r => r.json())
        .then(d => {
          showLoader(false);
          const renamed = d.renamed || [];
          const oldToNew = {};
          renamed.forEach(r => { oldToNew[r.old] = r.new; });
          ds.images.forEach(img => { if (oldToNew[img.filename]) img.filename = oldToNew[img.filename]; });
          selected.clear();
          renamed.forEach(r => selected.add(r.new));
          filteredImgs = [...ds.images];
          clearGrid('ds-grid-inner', 'ds-sentinel'); loadedMain = 0; loadBatchMain();
          toast(`${renamed.length} gambar berhasil direname`);
          if (d.errors?.length) toast(`${d.errors.length} error`, 'err');
        })
        .catch(e => { showLoader(false); toast(`Error: ${e.message}`, 'err'); });
    }
  };

  okBtn.onclick = () => submitRename("overwrite");
  addBtn.onclick = () => submitRename("prefix");
}

function doAnnotate() {
  if (!selected.size) return;
  const fns = [...selected];
  document.getElementById('confirm-title').textContent = 'Pindah ke Annotate';
  document.getElementById('confirm-body').textContent = `Pindahkan ${fns.length} gambar + label ke folder annotate/ ? File akan dipindahkan (bukan disalin).`;
  const okBtn = document.getElementById('confirm-ok');
  okBtn.className = 'btn btn-accent';
  okBtn.textContent = 'Pindahkan';
  openModal('confirm-modal');
  okBtn.onclick = () => {
    closeModal('confirm-modal');
    showLoader(true, 'Memindahkan…');
    fetch(`/api/dataset/${enc(ds.name)}/annotate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filenames: fns })
    })
      .then(r => r.json())
      .then(d => {
        showLoader(false);
        const moved = new Set(d.moved);
        ds.images = ds.images.filter(img => !moved.has(img.filename));
        annData = null;
        selected.clear(); syncSelUI();
        renderStats(ds.images, 'ds-stats', true);
        renderDist(ds.images, ds.classes, 'ds-dist');
        refreshTagsFilterDropdown();
        applyFilters();
        toast(`${d.moved.length} gambar dipindahkan ke annotate`);
        if (d.errors.length) toast(`${d.errors.length} error`, 'err');
        // reset button
        okBtn.className = 'btn btn-danger'; okBtn.textContent = 'OK';
      })
      .catch(e => { showLoader(false); toast(`Error: ${e.message}`, 'err'); });
  };
}

// ═══════════════════════════════════════════
// TAGS & CLASS MANAGEMENT & FILTERING
// ═══════════════════════════════════════════
let activeTagsFilter = new Set();

function toggleTagsFilterDropdown(e) {
  e.stopPropagation();
  const classMenu = document.getElementById('class-filter-menu');
  const labeledMenu = document.getElementById('labeled-filter-menu');
  const tagsMenu = document.getElementById('tags-filter-menu');
  if (classMenu) classMenu.classList.remove('show');
  if (labeledMenu) labeledMenu.classList.remove('show');
  if (tagsMenu) tagsMenu.classList.toggle('show');
}

function refreshTagsFilterDropdown() {
  fetch('/api/tags')
    .then(r => r.json())
    .then(tags => {
      const menu = document.getElementById('tags-filter-menu');
      if (!menu) return;
      menu.innerHTML = '';

      const allItem = document.createElement('div');
      allItem.className = 'dropdown-item';
      const allChecked = activeTagsFilter.size === 0;
      allItem.innerHTML = `<input type="checkbox" id="tag-filter-all" ${allChecked ? 'checked' : ''} style="accent-color:var(--accent)"><span>SEMUA</span>`;
      allItem.onclick = (e) => {
        e.stopPropagation();
        activeTagsFilter.clear();
        refreshTagsFilterDropdown();
        applyFilters();
      };
      menu.appendChild(allItem);

      // Compute counts of each tag in current dataset
      const localCounts = {};
      let localUntaggedCount = 0;
      const currentImgs = (currentPage === 'annotation' && annData) ? annData.images : (ds ? ds.images : []);
      currentImgs.forEach(img => {
        const tList = img.tags || [];
        if (tList.length === 0) {
          localUntaggedCount++;
        } else {
          tList.forEach(t => {
            localCounts[t] = (localCounts[t] || 0) + 1;
          });
        }
      });

      // Add "untagged" option
      const untaggedItem = document.createElement('div');
      untaggedItem.className = 'dropdown-item';
      const untaggedChecked = activeTagsFilter.has('__untagged__');
      untaggedItem.innerHTML = `<input type="checkbox" ${untaggedChecked ? 'checked' : ''} style="accent-color:var(--accent)"><span>untagged</span><span style="margin-left: auto; color: var(--text-muted); font-size: 0.75rem;">(${localUntaggedCount})</span>`;
      untaggedItem.onclick = (e) => {
        e.stopPropagation();
        if (activeTagsFilter.has('__untagged__')) {
          activeTagsFilter.delete('__untagged__');
        } else {
          activeTagsFilter.add('__untagged__');
        }
        refreshTagsFilterDropdown();
        applyFilters();
      };
      menu.appendChild(untaggedItem);

      tags.forEach(t => {
        const item = document.createElement('div');
        item.className = 'dropdown-item';
        const checked = activeTagsFilter.has(t.name);
        const count = localCounts[t.name] || 0;
        item.innerHTML = `<input type="checkbox" ${checked ? 'checked' : ''} style="accent-color:var(--accent)"><span>${esc(t.name)}</span><span style="margin-left: auto; color: var(--text-muted); font-size: 0.75rem;">(${count})</span>`;
        item.onclick = (e) => {
          e.stopPropagation();
          if (activeTagsFilter.has(t.name)) {
            activeTagsFilter.delete(t.name);
          } else {
            activeTagsFilter.add(t.name);
          }
          refreshTagsFilterDropdown();
          applyFilters();
        };
        menu.appendChild(item);
      });

      // Update button text
      const btn = document.getElementById('tags-filter-btn');
      if (btn) {
        if (activeTagsFilter.size === 0) {
          btn.querySelector('span').textContent = 'TAGS (ALL) ▾';
        } else {
          btn.querySelector('span').textContent = `TAGS (${activeTagsFilter.size}) ▾`;
        }
      }
    });
}

function doManageImageTags() {
  if (!selected.size) return;
  const fns = [...selected];

  fetch('/api/tags')
    .then(r => r.json())
    .then(tags => {
      const list = document.getElementById('image-tags-list');
      list.innerHTML = '';
      if (!tags.length) {
        list.innerHTML = '<div style="color:var(--text-muted);font-size:.85rem;text-align:center">Belum ada tag yang dibuat. Silakan tambahkan tag di Class Settings.</div>';
        document.getElementById('image-tags-save').disabled = true;
        openModal('image-tags-modal');
        return;
      }
      document.getElementById('image-tags-save').disabled = false;

      const tagCounts = {};
      fns.forEach(fn => {
        const img = ds.images.find(i => i.filename === fn);
        if (img && img.tags) {
          img.tags.forEach(t => { tagCounts[t] = (tagCounts[t] || 0) + 1; });
        }
      });

      tags.forEach(t => {
        const item = document.createElement('label');
        item.style.display = 'flex';
        item.style.alignItems = 'center';
        item.style.gap = '8px';
        item.style.padding = '6px 0';
        item.style.cursor = 'pointer';

        const count = tagCounts[t.name] || 0;
        const checked = count === fns.length;
        const indeterminate = count > 0 && count < fns.length;

        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.value = t.name;
        cb.checked = checked;
        cb.indeterminate = indeterminate;
        cb.style.accentColor = 'var(--accent)';

        item.appendChild(cb);

        const spanName = document.createElement('span');
        spanName.textContent = t.name;
        item.appendChild(spanName);

        if (count > 0 && count < fns.length) {
          const spanInfo = document.createElement('span');
          spanInfo.style.fontSize = '0.75rem';
          spanInfo.style.color = 'var(--text-muted)';
          spanInfo.textContent = ` (diterapkan pada ${count}/${fns.length} gambar)`;
          item.appendChild(spanInfo);
        }

        list.appendChild(item);
      });

      openModal('image-tags-modal');

      document.getElementById('image-tags-save').onclick = () => {
        const selectedTags = [];
        list.querySelectorAll('input[type=checkbox]').forEach(cb => {
          if (cb.checked) {
            selectedTags.push(cb.value);
          }
        });

        closeModal('image-tags-modal');
        showLoader(true, 'Menyimpan tags…');

        fetch(`/api/dataset/${enc(ds.name)}/image-tags`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filenames: fns, tags: selectedTags })
        })
          .then(r => r.json())
          .then(d => {
            if (d.detail) throw new Error(d.detail);
            showLoader(false);
            toast(`Tags berhasil disimpan untuk ${fns.length} gambar`);

            fns.forEach(fn => {
              const img = ds.images.find(i => i.filename === fn);
              if (img) img.tags = [...selectedTags];
            });

            selected.clear();
            syncSelUI();
            refreshTagsFilterDropdown();
            applyFilters();
          })
          .catch(e => { showLoader(false); toast(`Error: ${e.message}`, 'err'); });
      };
    });
}

function loadTagsManager() {
  fetch('/api/tags')
    .then(r => r.json())
    .then(tags => {
      const list = document.getElementById('tags-list');
      if (!list) return;
      list.innerHTML = '';
      if (!tags.length) {
        list.innerHTML = '<div style="color:var(--text-muted);font-size:.85rem;padding:10px 0">Belum ada tags</div>';
        return;
      }
      tags.forEach(t => {
        const row = document.createElement('div');
        row.className = 'cls-row';
        row.style.justifyContent = 'space-between';
        row.innerHTML = `
          <span style="font-weight:600;color:var(--text-primary)">${esc(t.name)}</span>
          <div style="display:flex;align-items:center;gap:12px">
            <span class="badge">${t.count} gambar</span>
            <button class="btn btn-ghost" style="padding: 4px; color: var(--danger)" onclick="deleteTag('${esc(t.name)}')">
              <svg viewBox="0 0 24 24" style="width:16px;height:16px;fill:currentColor"><path d="M19,4H15.5L14.5,3H9.5L8.5,4H5V6H19M6,19A2,2 0 0,0 8,21H16A2,2 0 0,0 18,19V7H6V19Z"/></svg>
            </button>
          </div>`;
        list.appendChild(row);
      });
    });
}

function addNewTag() {
  const inp = document.getElementById('new-tag-inp');
  const name = inp.value.trim();
  if (!name) return;
  fetch('/api/tags', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: name })
  })
    .then(r => r.json())
    .then(d => {
      if (d.detail) throw new Error(d.detail);
      inp.value = '';
      toast(`Tag "${name}" berhasil ditambahkan`);
      loadTagsManager();
      refreshTagsFilterDropdown();
    })
    .catch(e => toast(`Error: ${e.message}`, 'err'));
}

function deleteTag(name) {
  fetch('/api/tags')
    .then(r => r.json())
    .then(tags => {
      const tag = tags.find(t => t.name === name);
      const count = tag ? tag.count : 0;

      document.getElementById('confirm-title').textContent = 'Hapus Tag';
      document.getElementById('confirm-body').innerHTML = `Hapus tag <strong>${esc(name)}</strong>?<br><br>Tag akan dihapus dari <strong>${count}</strong> gambar secara permanen.`;

      const okBtn = document.getElementById('confirm-ok');
      okBtn.className = 'btn btn-danger';
      okBtn.textContent = 'Hapus';
      okBtn.onclick = () => {
        closeModal('confirm-modal');
        showLoader(true, 'Menghapus tag…');
        fetch(`/api/tags/${enc(name)}`, { method: 'DELETE' })
          .then(r => r.json())
          .then(() => {
            showLoader(false);
            toast(`Tag "${name}" dihapus`);
            loadTagsManager();
            refreshTagsFilterDropdown();
            if (ds) {
              loadDataset(ds.name, currentPage, false);
            }
          })
          .catch(e => { showLoader(false); toast(`Error: ${e.message}`, 'err'); });
      };
      openModal('confirm-modal');
    });
}

function addNewClassRow() {
  const list = document.getElementById('cls-list');
  if (!list) return;
  const nextIdx = list.querySelectorAll('.cls-row').length;
  const col = '#ff0000';
  const row = document.createElement('div');
  row.className = 'cls-row new-row';
  row.dataset.i = nextIdx;
  row.innerHTML = `
    <span class="cls-idx">#${nextIdx}</span>
    <input class="cls-name-inp" type="text" value="" placeholder="class_${nextIdx}">
    <div class="col-wrap" style="background:${col}">
      <input class="col-inp" type="color" value="${col}">
    </div>
    <button class="btn btn-ghost" style="padding: 4px; color: var(--danger)" onclick="removeNewClassRow(this)">
      <svg viewBox="0 0 24 24" style="width:16px;height:16px;fill:currentColor"><path d="M19,4H15.5L14.5,3H9.5L8.5,4H5V6H19M6,19A2,2 0 0,0 8,21H16A2,2 0 0,0 18,19V7H6V19Z"/></svg>
    </button>`;
  row.querySelector('.col-inp').addEventListener('input', e => {
    row.querySelector('.col-wrap').style.background = e.target.value;
  });
  list.appendChild(row);
}

function removeNewClassRow(btn) {
  const row = btn.closest('.cls-row');
  row.remove();
  const list = document.getElementById('cls-list');
  if (list) {
    list.querySelectorAll('.cls-row').forEach((r, idx) => {
      r.dataset.i = idx;
      r.querySelector('.cls-idx').textContent = `#${idx}`;
    });
  }
}

function deleteClass(classId) {
  if (!ds) return;
  const className = ds.classes.names[classId];
  showLoader(true, 'Menghitung anotasi…');

  fetch(`/api/dataset/${enc(ds.name)}/class-annotations-count/${classId}`)
    .then(r => r.json())
    .then(d => {
      showLoader(false);
      const count = d.count;

      document.getElementById('confirm-title').textContent = 'Hapus Class';
      document.getElementById('confirm-body').innerHTML = `Anda ingin menghapus class <strong>${esc(className)}</strong>?<br><br>Warning: <strong>${count}</strong> anotasi untuk class ini akan dihapus secara permanen dari semua file label. Tindakan ini tidak dapat dibatalkan.`;

      const okBtn = document.getElementById('confirm-ok');
      okBtn.className = 'btn btn-danger';
      okBtn.textContent = 'Hapus Permanen';
      okBtn.onclick = () => {
        closeModal('confirm-modal');
        startClassDeletion(classId, className);
      };
      openModal('confirm-modal');
    })
    .catch(e => {
      showLoader(false);
      toast(`Gagal menghitung anotasi: ${e.message}`, 'err');
    });
}

function startClassDeletion(classId, className) {
  document.getElementById('progress-title').textContent = `Menghapus Class "${className}"`;
  document.getElementById('progress-percent').textContent = '0%';
  document.getElementById('progress-desc').textContent = 'Mengupdate file label...';
  openModal('progress-modal');

  fetch(`/api/dataset/${enc(ds.name)}/delete-class/${classId}`, { method: 'POST' })
    .then(r => r.json())
    .then(d => {
      if (!d.success) throw new Error(d.detail || 'Gagal memulai penghapusan');
      pollDeleteClassProgress(classId);
    })
    .catch(e => {
      closeModal('progress-modal');
      toast(`Error: ${e.message}`, 'err');
    });
}

function pollDeleteClassProgress(classId) {
  const timer = setInterval(() => {
    fetch(`/api/dataset/${enc(ds.name)}/delete-class-progress/${classId}`)
      .then(r => r.json())
      .then(d => {
        const p = d.progress;
        if (p === -1.0) {
          clearInterval(timer);
          closeModal('progress-modal');
          toast('Terjadi kesalahan saat menghapus class', 'err');
        } else if (p >= 100.0) {
          clearInterval(timer);
          document.getElementById('progress-percent').textContent = '100%';
          setTimeout(() => {
            closeModal('progress-modal');
            toast('Class berhasil dihapus!');
            loadDataset(ds.name, 'class', false);
          }, 500);
        } else {
          document.getElementById('progress-percent').textContent = `${p}%`;
        }
      })
      .catch(() => { });
  }, 300);
}

// ═══════════════════════════════════════════
// Utilities
// ═══════════════════════════════════════════
function switchView(id) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}
function buildCmap(classes) {
  const m = {};
  (classes.names || []).forEach((name, i) => { m[i] = { name, color: classes.color[i] || '#f00' }; });
  return m;
}
function enc(s) { return encodeURIComponent(s); }
function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

// ═══════════════════════════════════════════
// SETTINGS
// ═══════════════════════════════════════════
function loadLLMSettings() {
  fetch('/api/llm-settings')
    .then(r => r.json())
    .then(s => {
      document.getElementById('set-api-url').value = s.api_url || '';
      document.getElementById('set-api-key').value = s.api_key || '';
      document.getElementById('set-model').value = s.model || '';
      const dsTypeSel = document.getElementById('set-dataset-type');
      if (dsTypeSel) dsTypeSel.value = s.dataset_type || 'object_detection';
    })
    .catch(() => { });
}

function saveLLMSettings() {
  const dsTypeSel = document.getElementById('set-dataset-type');
  const payload = {
    api_url: document.getElementById('set-api-url').value.trim() || 'http://127.0.0.1:1234',
    api_key: document.getElementById('set-api-key').value.trim(),
    model: document.getElementById('set-model').value.trim(),
    dataset_type: dsTypeSel ? dsTypeSel.value : 'object_detection'
  };
  fetch('/api/llm-settings', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  })
    .then(r => r.json())
    .then(d => { if (d.success) toast('Settings tersimpan!'); })
    .catch(e => toast(`Error: ${e.message}`, 'err'));
}

function saveDatasetSettings() {
  const dsTypeSel = document.getElementById('set-dataset-type');
  const payload = {
    api_url: document.getElementById('set-api-url').value.trim() || 'http://127.0.0.1:1234',
    api_key: document.getElementById('set-api-key').value.trim(),
    model: document.getElementById('set-model').value.trim(),
    dataset_type: dsTypeSel ? dsTypeSel.value : 'object_detection'
  };
  fetch('/api/llm-settings', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  })
    .then(r => r.json())
    .then(d => { if (d.success) toast('Dataset settings berhasil disimpan!'); })
    .catch(e => toast(`Error: ${e.message}`, 'err'));
}

function checkDataset() {
  if (!ds) {
    toast('Silakan pilih dan muat dataset terlebih dahulu!', 'err');
    return;
  }

  let typeParam = '';
  const dsTypeSel = document.getElementById('set-dataset-type');
  if (dsTypeSel) {
    typeParam = `?type=${enc(dsTypeSel.value)}`;
  }

  showLoader(true, 'Memindai dataset...');
  fetch(`/api/dataset/${enc(ds.name)}/check-segment${typeParam}`)
    .then(r => r.json())
    .then(data => {
      showLoader(false);
      const count = data.count;
      const images = data.images;
      const type = data.dataset_type || 'object_detection';

      if (type === 'segment') {
        if (count === 0) {
          toast('Pengecekan selesai: Semua gambar telah menggunakan anotasi segment (Polygon)! ✓');
        } else {
          document.getElementById('confirm-title').textContent = 'Pindahkan Mismatch ke Staging';
          document.getElementById('confirm-body').textContent = `Ditemukan ${count} gambar dengan anotasi Bounding Box (seharusnya Segment/Polygon). Apakah Anda ingin memindahkannya ke staging area ANNOTATE untuk diperbaiki?`;
          const okBtn = document.getElementById('confirm-ok');
          okBtn.className = 'btn btn-accent';
          okBtn.textContent = 'Pindahkan';
          openModal('confirm-modal');
          okBtn.onclick = () => {
            closeModal('confirm-modal');
            executeMoveToAnnotate(images);
          };
        }
      } else {
        // object_detection
        if (count === 0) {
          toast('Pengecekan selesai: Semua gambar telah menggunakan anotasi Bounding Box! ✓');
        } else {
          document.getElementById('confirm-title').textContent = 'Pindahkan Mismatch ke Staging';
          document.getElementById('confirm-body').textContent = `Ditemukan ${count} gambar dengan anotasi Segment/Polygon (seharusnya Bounding Box). Apakah Anda ingin memindahkannya ke staging area ANNOTATE untuk diperbaiki?`;
          const okBtn = document.getElementById('confirm-ok');
          okBtn.className = 'btn btn-accent';
          okBtn.textContent = 'Pindahkan';
          openModal('confirm-modal');
          okBtn.onclick = () => {
            closeModal('confirm-modal');
            executeMoveToAnnotate(images);
          };
        }
      }
    })
    .catch(e => {
      showLoader(false);
      toast(`Error: ${e.message}`, 'err');
    });
}

function executeMoveToAnnotate(images) {
  showLoader(true, 'Memindahkan gambar...');
  fetch(`/api/dataset/${enc(ds.name)}/move-to-annotate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filenames: images })
  })
    .then(r => r.json())
    .then(res => {
      showLoader(false);
      if (res.moved && res.moved.length > 0) {
        toast(`Berhasil memindahkan ${res.moved.length} gambar ke staging area ANNOTATE!`);
        loadDataset(ds.name, 'dataset', false);
      } else {
        toast('Gagal memindahkan gambar', 'err');
      }
    })
    .catch(e => {
      showLoader(false);
      toast(`Error: ${e.message}`, 'err');
    });
}

function testLLMConnection() {
  const btn = document.getElementById('set-test-btn');
  const statusEl = document.getElementById('set-conn-status');
  const chipsEl = document.getElementById('set-model-chips');
  btn.disabled = true;
  statusEl.innerHTML = '<span class="conn-dot loading"></span> Menghubungkan…';
  chipsEl.innerHTML = '';

  // First save current values so proxy picks them up
  const payload = {
    api_url: document.getElementById('set-api-url').value.trim() || 'http://127.0.0.1:1234',
    api_key: document.getElementById('set-api-key').value.trim(),
    model: document.getElementById('set-model').value.trim()
  };
  fetch('/api/llm-settings', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  })
    .then(() => fetch('/api/llm/models'))
    .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
    .then(data => {
      const models = data.data || [];
      btn.disabled = false;
      if (!models.length) {
        statusEl.innerHTML = '<span class="conn-dot ok"></span> Terhubung — tidak ada model yang dimuat';
        chipsEl.innerHTML = '<span style="color:var(--text-muted);font-size:.85rem">Tidak ada model aktif</span>';
        return;
      }
      statusEl.innerHTML = `<span class="conn-dot ok"></span> Terhubung — ${models.length} model tersedia`;
      chipsEl.innerHTML = '';
      const currentModel = document.getElementById('set-model').value.trim();
      models.forEach(m => {
        const chip = document.createElement('div');
        chip.className = 'model-chip' + (m.id === currentModel ? ' selected' : '');
        chip.innerHTML = `<span class="model-chip-id">${esc(m.id)}</span><span class="model-chip-owner">${esc(m.owned_by || '')}</span>`;
        chip.onclick = () => {
          document.getElementById('set-model').value = m.id;
          chipsEl.querySelectorAll('.model-chip').forEach(c => c.classList.remove('selected'));
          chip.classList.add('selected');
        };
        chipsEl.appendChild(chip);
      });
    })
    .catch(e => {
      btn.disabled = false;
      statusEl.innerHTML = `<span class="conn-dot err"></span> Gagal: ${esc(e.message)}`;
      chipsEl.innerHTML = '';
    });
}

// ═══════════════════════════════════════════
// CATEGORIZE — state
// ═══════════════════════════════════════════
let catTags = [];            // [{name: string, desc: string}]
let catMethod = 'llm';
let catSelectedImgs = new Set();
let catClsFilter = new Set();
let catTagsFilter = new Set(); // Set of existing tag names to filter images in selection grid
let catRunning = false;
let catShouldStop = false;
let catQueue = [];
let catDone = 0;
let catTotal = 0;
let catRepOk = 0, catRepEmpty = 0, catRepFail = 0;
let catFailedItems = [];     // [{filename, rawText}]
let sysPromptEditing = false;

// New state for stop, pause, and history
let catControllers = {};       // Per-slot AbortController dictionary
let catPaused = false;
let catPausing = false;
let catActiveWorkers = new Set();
let catRecentResults = [];     // Max 5 items: {filename, status, tags/errorText}

function selectCatMethod(m) {
  catMethod = m;
  document.querySelectorAll('.method-btn').forEach(b => b.classList.remove('active'));
  const btn = document.getElementById(`cat-method-${m}`);
  if (btn) btn.classList.add('active');
}

// ── Tag rows (per-tag name + description) ──
function addCatTagRow(name, desc) {
  catTags.push({ name: name || '', desc: desc || '' });
  renderCatTagRows();
  updateSysPrompt();
  updateStartBtn();
  // focus the new name input
  const rows = document.querySelectorAll('#cat-tag-rows .tag-row');
  if (rows.length) rows[rows.length - 1].querySelector('.name-inp')?.focus();
}

function removeCatTagRow(i) {
  catTags.splice(i, 1);
  renderCatTagRows();
  updateSysPrompt();
  updateStartBtn();
}

function renderCatTagRows() {
  const table = document.getElementById('cat-tag-rows');
  if (!table) return;
  // keep header, remove old rows
  table.querySelectorAll('.tag-row').forEach(r => r.remove());
  catTags.forEach((t, i) => {
    const row = document.createElement('div');
    row.className = 'tag-row';
    row.innerHTML = `
      <input class="tag-row-inp name-inp" type="text" placeholder="nama tag" value="${esc(t.name)}"
        oninput="catTagRowChange(${i},'name',this.value)" onkeydown="catTagRowKey(event,${i})">
      <input class="tag-row-inp" type="text" placeholder="deskripsi (opsional)" value="${esc(t.desc)}"
        oninput="catTagRowChange(${i},'desc',this.value)">
      <button class="tag-row-rm" onclick="removeCatTagRow(${i})" title="Hapus">×</button>`;
    table.appendChild(row);
  });
}

function catTagRowChange(i, field, val) {
  if (!catTags[i]) return;
  catTags[i][field] = val.trim();
  updateSysPrompt();
  updateStartBtn();
}

function catTagRowKey(e, i) {
  // Enter on last row → add new row
  if (e.key === 'Enter') {
    e.preventDefault();
    if (i === catTags.length - 1) addCatTagRow();
    else {
      const rows = document.querySelectorAll('#cat-tag-rows .tag-row');
      rows[i + 1]?.querySelector('.name-inp')?.focus();
    }
  }
}

// ── System prompt ──
function buildSystemPrompt(tags) {
  // tags is now [{name, desc}]
  const validTags = tags.filter(t => t.name.trim());
  const tagList = validTags.map(t => t.name.trim()).join(', ');
  const descLines = validTags.filter(t => t.desc.trim()).map(t => `  - "${t.name}": ${t.desc}`).join('\n');
  const descSection = descLines ? `\nTag descriptions:\n${descLines}` : '';
  return `You are an image analysis assistant. Analyze the provided image carefully.${descSection}
Available tags: [${tagList}]
Return ONLY a valid JSON object with this exact format (no markdown, no explanation):
{"tags": ["tag_name_1", "tag_name_2"]}
Rules:
- Only include tags from the available tags list that are actually visible or relevant in the image
- You may return multiple tags or an empty array if none match
- Do NOT include any text outside the JSON object`;
}

function updateSysPrompt() {
  if (sysPromptEditing) return;
  const ta = document.getElementById('cat-sys-prompt');
  const validTags = catTags.filter(t => t.name.trim());
  if (ta) ta.value = validTags.length ? buildSystemPrompt(catTags) : '';
}

function toggleSysPromptEdit() {
  sysPromptEditing = !sysPromptEditing;
  const ta = document.getElementById('cat-sys-prompt');
  const btn = document.getElementById('cat-sys-edit-btn');
  ta.disabled = !sysPromptEditing;
  btn.textContent = sysPromptEditing ? 'Lock' : 'Edit';
  btn.classList.toggle('editing', sysPromptEditing);
  if (sysPromptEditing) ta.focus();
}

// ── Batch size ──
function validateBatchSize() {
  const inp = document.getElementById('cat-batch-size');
  if (!inp) return;
  const v = parseInt(inp.value);
  const invalid = isNaN(v) || v < 1;
  inp.classList.toggle('invalid', invalid);
  updateStartBtn();
}

// ── Init cat page ──
function initCatPage() {
  if (!ds) return;
  catTagsFilter.clear(); // Reset filter tags
  buildCatPills();
  refreshCatTagsFilterDropdown();
  renderCatGrid();
  renderCatTagRows();
  updateStartBtn();
}

function buildCatPills() {
  if (!ds) return;
  const wrap = document.getElementById('cat-pills-wrap');
  if (!wrap) return;
  let html = `<button class="pill${catClsFilter.size === 0 ? ' active' : ''}" onclick="toggleCatFilter('all')">Semua</button>`;
  ds.classes.names.forEach((name, i) => {
    const col = ds.classes.color[i] || '#f00';
    const on = catClsFilter.has(i);
    html += `<button class="pill${on ? ' active' : ''}" onclick="toggleCatFilter(${i})" style="${on ? `background:${col}20;border-color:${col};color:${col}` : ''}">
      <span class="pill-dot" style="background:${col}"></span>${esc(name)}</button>`;
  });
  wrap.innerHTML = html;
}

function toggleCatFilter(id) {
  if (id === 'all') catClsFilter.clear();
  else catClsFilter.has(id) ? catClsFilter.delete(id) : catClsFilter.add(id);
  buildCatPills();
  renderCatGrid();
}

function toggleCatTagsFilterDropdown(e) {
  e.stopPropagation();
  document.getElementById('cat-tags-filter-menu').classList.toggle('show');
}

// close categorize tag filter menu on click outside
document.addEventListener('click', () => {
  const el = document.getElementById('cat-tags-filter-menu');
  if (el) el.classList.remove('show');
});

function refreshCatTagsFilterDropdown() {
  fetch('/api/tags')
    .then(r => r.json())
    .then(tags => {
      const menu = document.getElementById('cat-tags-filter-menu');
      if (!menu) return;
      menu.innerHTML = '';

      const allItem = document.createElement('div');
      allItem.className = 'dropdown-item';
      const allChecked = catTagsFilter.size === 0;
      allItem.innerHTML = `<input type="checkbox" ${allChecked ? 'checked' : ''}><span>SEMUA</span>`;
      allItem.onclick = (e) => {
        e.stopPropagation();
        catTagsFilter.clear();
        refreshCatTagsFilterDropdown();
        renderCatGrid();
      };
      menu.appendChild(allItem);

      // Compute counts of each tag in current dataset
      const localCounts = {};
      let localUntaggedCount = 0;
      if (ds && ds.images) {
        ds.images.forEach(img => {
          const tList = img.tags || [];
          if (tList.length === 0) {
            localUntaggedCount++;
          } else {
            tList.forEach(t => {
              localCounts[t] = (localCounts[t] || 0) + 1;
            });
          }
        });
      }

      // Add "untagged" option
      const untaggedItem = document.createElement('div');
      untaggedItem.className = 'dropdown-item';
      const untaggedChecked = catTagsFilter.has('__untagged__');
      untaggedItem.innerHTML = `<input type="checkbox" ${untaggedChecked ? 'checked' : ''}><span>untagged</span><span style="margin-left: auto; color: var(--text-muted); font-size: 0.75rem;">(${localUntaggedCount})</span>`;
      untaggedItem.onclick = (e) => {
        e.stopPropagation();
        if (catTagsFilter.has('__untagged__')) {
          catTagsFilter.delete('__untagged__');
        } else {
          catTagsFilter.add('__untagged__');
        }
        refreshCatTagsFilterDropdown();
        renderCatGrid();
      };
      menu.appendChild(untaggedItem);

      tags.forEach(t => {
        const item = document.createElement('div');
        item.className = 'dropdown-item';
        const checked = catTagsFilter.has(t.name);
        const count = localCounts[t.name] || 0;
        item.innerHTML = `<input type="checkbox" ${checked ? 'checked' : ''}><span>${esc(t.name)}</span><span style="margin-left: auto; color: var(--text-muted); font-size: 0.75rem;">(${count})</span>`;
        item.onclick = (e) => {
          e.stopPropagation();
          if (catTagsFilter.has(t.name)) {
            catTagsFilter.delete(t.name);
          } else {
            catTagsFilter.add(t.name);
          }
          refreshCatTagsFilterDropdown();
          renderCatGrid();
        };
        menu.appendChild(item);
      });
    });
}

function getCatFilteredImgs() {
  if (!ds) return [];
  let imgs = ds.images;

  // Filter by classes
  if (catClsFilter.size > 0) {
    imgs = imgs.filter(img => img.annotations.some(a => catClsFilter.has(a.class_id)));
  }

  // Filter by existing tags
  if (catTagsFilter.size > 0) {
    imgs = imgs.filter(img => {
      const tList = img.tags || [];
      if (catTagsFilter.has('__untagged__') && tList.length === 0) {
        return true;
      }
      return tList.some(t => catTagsFilter.has(t));
    });
  }

  return imgs;
}

function renderCatGrid() {
  const grid = document.getElementById('cat-grid');
  if (!grid) return;
  const imgs = getCatFilteredImgs();
  grid.innerHTML = '';
  imgs.forEach(img => {
    const card = document.createElement('div');
    card.className = 'cat-card' + (catSelectedImgs.has(img.filename) ? ' cat-selected' : '');
    card.dataset.fn = img.filename;
    card.onclick = () => toggleCatCard(card);
    card.innerHTML = `
      <div class="cat-card-img">
        <img src="/dataset/${enc(ds.name)}/images/${enc(img.filename)}" loading="lazy" alt="${esc(img.filename)}">
        <div class="cat-card-chk"><svg viewBox="0 0 24 24"><path d="M9,16.17L4.83,12L3.41,13.41L9,19L21,7L19.59,5.59L9,16.17Z"/></svg></div>
      </div>
      <div class="cat-card-name" title="${esc(img.filename)}">${esc(img.filename)}</div>`;
    grid.appendChild(card);
  });
  updateCatSelCount();
}

function toggleCatCard(card) {
  const fn = card.dataset.fn;
  if (catSelectedImgs.has(fn)) { catSelectedImgs.delete(fn); card.classList.remove('cat-selected'); }
  else { catSelectedImgs.add(fn); card.classList.add('cat-selected'); }
  updateCatSelCount();
  updateStartBtn();
}

function catSelectAll() {
  getCatFilteredImgs().forEach(img => catSelectedImgs.add(img.filename));
  document.querySelectorAll('.cat-card').forEach(c => c.classList.add('cat-selected'));
  updateCatSelCount();
  updateStartBtn();
}

function catSelectNone() {
  catSelectedImgs.clear();
  document.querySelectorAll('.cat-card').forEach(c => c.classList.remove('cat-selected'));
  updateCatSelCount();
  updateStartBtn();
}

function updateCatSelCount() {
  const el = document.getElementById('cat-sel-count');
  if (el) el.textContent = `${catSelectedImgs.size} dipilih`;
}

function updateStartBtn() {
  const btn = document.getElementById('cat-start-btn');
  if (!btn) return;
  const batchOk = (() => { const v = parseInt(document.getElementById('cat-batch-size')?.value); return !isNaN(v) && v >= 1; })();
  const hasValidTag = catTags.some(t => t.name.trim());
  btn.disabled = !(hasValidTag && catSelectedImgs.size > 0 && batchOk);
}

// ═══════════════════════════════════════════
// CATEGORIZE — Monitor / Run
// ═══════════════════════════════════════════
async function startCategorize() {
  if (!ds) return;
  catQueue = [...catSelectedImgs];
  catTotal = catQueue.length;
  catDone = 0;
  catRepOk = 0; catRepEmpty = 0; catRepFail = 0;
  catFailedItems = [];
  catRunning = true;
  catShouldStop = false;
  catPaused = false;
  catPausing = false;
  catControllers = {};
  catActiveWorkers.clear();
  catRecentResults = [];
  renderRecentResults();

  // Resolve tags to name strings only for LLM
  // (descriptions are embedded in system prompt by buildSystemPrompt)
  const resolvedTags = catTags.filter(t => t.name.trim()).map(t => t.name.trim());
  if (!resolvedTags.length) { toast('Tambahkan setidaknya 1 tag terlebih dahulu.', 'err'); return; }

  // Populate active model in select dropdown
  const settings = await fetch('/api/llm-settings').then(r => r.json()).catch(() => ({}));
  const mSelect = document.getElementById('monitor-model-select');
  if (mSelect && settings.model) {
    mSelect.innerHTML = `<option value="${esc(settings.model)}" selected>${esc(settings.model)}</option>`;
  }

  // Switch to monitor UI
  document.getElementById('cat-setup').style.display = 'none';
  document.getElementById('cat-monitor').classList.add('active');
  document.getElementById('cat-report').classList.remove('visible');

  // reset Pause button text
  const pBtn = document.getElementById('monitor-pause-btn');
  if (pBtn) {
    pBtn.disabled = false;
    pBtn.textContent = 'Pause';
    pBtn.className = 'btn btn-ghost';
  }

  updateMonitorProgress();

  const batchSize = Math.max(1, parseInt(document.getElementById('cat-batch-size').value) || 4);

  // Build worker cards
  const workersEl = document.getElementById('monitor-workers');
  if (workersEl) {
    workersEl.innerHTML = '';
    for (let i = 0; i < batchSize; i++) {
      const wc = document.createElement('div');
      wc.className = 'worker-card';
      wc.id = `worker-${i}`;
      wc.innerHTML = `
        <div class="worker-card-img">
          <img src="" alt="" class="loading" id="wimg-${i}">
          <span class="worker-slot-badge">SLOT ${i + 1}</span>
          <span class="worker-status-badge idle" id="wstatus-${i}">IDLE</span>
        </div>
        <div class="worker-body">
          <div class="worker-filename" id="wfn-${i}">—</div>
          <div class="worker-thinking" id="wthink-${i}"></div>
          <div class="worker-answer" id="wanswer-${i}"></div>
          <div class="worker-result-tags" id="wtags-${i}"></div>
        </div>`;
      workersEl.appendChild(wc);
    }
  }

  // Start workers
  const workers = [];
  for (let i = 0; i < batchSize; i++) {
    workers.push(runWorker(i));
  }
  await Promise.all(workers);
  catRunning = false;
  showReport();
}

async function runWorker(slot) {
  while (catQueue.length > 0 && !catShouldStop) {
    if (catPausing || catPaused) {
      break; // Pause requested or already paused, stop pulling new images
    }
    const filename = catQueue.shift();
    if (!filename) break;
    catActiveWorkers.add(slot);
    try {
      await processImage(slot, filename);
    } finally {
      catActiveWorkers.delete(slot);
    }

    if (catPausing && catActiveWorkers.size === 0) {
      catPaused = true;
      catPausing = false;
      const pBtn = document.getElementById('monitor-pause-btn');
      if (pBtn) {
        pBtn.disabled = false;
        pBtn.textContent = 'Resume';
        pBtn.className = 'btn btn-accent';
      }
      document.getElementById('monitor-subtitle').textContent = 'Di-pause (batch selesai).';
    }
  }
  // Mark idle when done
  setWorkerStatus(slot, 'idle', '—', '');
}

async function processImage(slot, filename) {
  setWorkerStatus(slot, 'processing', filename, '');
  document.getElementById(`wthink-${slot}`).style.display = 'none';
  document.getElementById(`wthink-${slot}`).textContent = '';
  document.getElementById(`wanswer-${slot}`).style.display = 'none';
  document.getElementById(`wanswer-${slot}`).textContent = '';
  document.getElementById(`wtags-${slot}`).style.display = 'none';
  document.getElementById(`wtags-${slot}`).innerHTML = '';

  // Setup abort controller
  const controller = new AbortController();
  catControllers[slot] = controller;
  const signal = controller.signal;

  // Load image
  const imgEl = document.getElementById(`wimg-${slot}`);
  imgEl.classList.add('loading');
  imgEl.src = `/dataset/${enc(ds.name)}/images/${enc(filename)}`;
  imgEl.onload = () => imgEl.classList.remove('loading');

  let rawAnswer = '';
  let thinkingBuf = '';

  try {
    // Fetch base64
    const b64resp = await fetch(`/api/dataset/${enc(ds.name)}/image-base64/${enc(filename)}`, { signal });
    if (!b64resp.ok) throw new Error('Gagal load image');
    const { base64, mime_type } = await b64resp.json();

    const sysPrompt = document.getElementById('cat-sys-prompt').value.trim() || buildSystemPrompt(catTags);

    const settings = await fetch('/api/llm-settings').then(r => r.json()).catch(() => ({}));

    const chatPayload = {
      model: settings.model || '',
      stream: true,
      messages: [
        { role: 'system', content: sysPrompt },
        {
          role: 'user', content: [
            { type: 'text', text: 'Analyze this image and return the matching tags as JSON.' },
            { type: 'image_url', image_url: { url: `data:${mime_type};base64,${base64}` } }
          ]
        }
      ]
    };

    const resp = await fetch('/api/llm/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(chatPayload),
      signal
    });

    if (!resp.ok) throw new Error(`LLM error HTTP ${resp.status}`);

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop(); // keep incomplete line
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data:')) continue;
        const data = trimmed.slice(5).trim();
        if (data === '[DONE]') continue;
        try {
          const chunk = JSON.parse(data);
          const delta = chunk.choices?.[0]?.delta;
          if (!delta) continue;
          // thinking stream
          if (delta.reasoning_content) {
            thinkingBuf += delta.reasoning_content;
            const thinkEl = document.getElementById(`wthink-${slot}`);
            thinkEl.style.display = 'block';
            thinkEl.textContent = thinkingBuf.slice(-200); // show last 200 chars
          }
          // answer stream
          if (delta.content) {
            rawAnswer += delta.content;
            const ansEl = document.getElementById(`wanswer-${slot}`);
            ansEl.style.display = 'block';
            ansEl.textContent = rawAnswer;
          }
        } catch (_) { }
      }
      if (catShouldStop) break;
    }

    // Hide thinking, hide answer stream
    document.getElementById(`wthink-${slot}`).style.display = 'none';
    document.getElementById(`wanswer-${slot}`).style.display = 'none';

    // Parse JSON
    const tags = parseLLMTags(rawAnswer);

    if (tags === null) {
      // parse fail
      catRepFail++;
      catFailedItems.push({ filename, rawText: rawAnswer });
      setWorkerStatus(slot, 'failed', filename, '');
      showResultTags(slot, [], true);
      addRecentResult(filename, 'fail', rawAnswer || 'Empty output');
    } else if (tags.length === 0) {
      catRepEmpty++;
      setWorkerStatus(slot, 'done', filename, '');
      showResultTags(slot, [], false);
      addRecentResult(filename, 'empty', []);
    } else {
      // Apply tags
      await applyTagsToImage(filename, tags);
      catRepOk++;
      setWorkerStatus(slot, 'done', filename, '');
      showResultTags(slot, tags, false);
      addRecentResult(filename, 'ok', tags);
    }
  } catch (err) {
    if (err.name !== 'AbortError') {
      catRepFail++;
      catFailedItems.push({ filename, rawText: String(err) });
      setWorkerStatus(slot, 'failed', filename, '');
      addRecentResult(filename, 'fail', String(err));
    }
    document.getElementById(`wthink-${slot}`).style.display = 'none';
    document.getElementById(`wanswer-${slot}`).style.display = 'none';
  } finally {
    delete catControllers[slot];
  }

  catDone++;
  updateMonitorProgress();
}

function parseLLMTags(text) {
  if (!text) return null;
  // Try to extract JSON object from text
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;
  try {
    const obj = JSON.parse(jsonMatch[0]);
    if (Array.isArray(obj.tags)) {
      return obj.tags.filter(t => typeof t === 'string' && t.trim()).map(t => t.trim());
    }
    // Jika berhasil diparse sebagai JSON object tetapi tidak memiliki field "tags" (misal {}),
    // kita anggap sebagai valid empty no tags.
    if (typeof obj === 'object' && obj !== null) {
      return [];
    }
    return null;
  } catch (_) {
    return null;
  }
}

async function applyTagsToImage(filename, tags) {
  if (!ds || !tags.length) return;
  // Ensure tags exist in DB first (create if not)
  const existingTags = await fetch('/api/tags').then(r => r.json()).catch(() => []);
  const existingNames = new Set(existingTags.map(t => t.name));
  for (const tag of tags) {
    if (!existingNames.has(tag)) {
      await fetch('/api/tags', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: tag })
      }).catch(() => { });
    }
  }
  // Get current tags on this image and merge
  const img = ds.images.find(i => i.filename === filename);
  const currentTags = img?.tags || [];
  const mergedTags = [...new Set([...currentTags, ...tags])];

  await fetch(`/api/dataset/${enc(ds.name)}/image-tags`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filenames: [filename], tags: mergedTags })
  });

  // Update local state
  if (img) img.tags = mergedTags;
}

function setWorkerStatus(slot, status, filename, _unused) {
  const card = document.getElementById(`worker-${slot}`);
  if (!card) return;
  card.className = `worker-card ${status === 'idle' ? '' : status}`;
  const sb = document.getElementById(`wstatus-${slot}`);
  if (sb) { sb.className = `worker-status-badge ${status}`; sb.textContent = status.toUpperCase(); }
  const fn = document.getElementById(`wfn-${slot}`);
  if (fn) fn.textContent = filename;
}

function showResultTags(slot, tags, failed) {
  const el = document.getElementById(`wtags-${slot}`);
  if (!el) return;
  if (failed) {
    el.innerHTML = '<span class="worker-result-tag" style="background:rgba(239,68,68,.12);color:var(--danger);border-color:rgba(239,68,68,.25)">PARSE FAIL</span>';
    el.style.display = 'flex';
  } else if (tags.length > 0) {
    el.innerHTML = tags.map(t => `<span class="worker-result-tag">${esc(t)}</span>`).join('');
    el.style.display = 'flex';
  } else {
    el.innerHTML = '<span class="worker-result-tag" style="background:rgba(148,163,184,.08);color:var(--text-muted);border-color:rgba(148,163,184,.15)">no tags</span>';
    el.style.display = 'flex';
  }
}

function updateMonitorProgress() {
  const pct = catTotal > 0 ? Math.round(catDone / catTotal * 100) : 0;
  const bar = document.getElementById('monitor-prog-bar');
  if (bar) bar.style.width = `${pct}%`;
  const doneLabel = document.getElementById('monitor-prog-done');
  if (doneLabel) doneLabel.textContent = `${catDone} / ${catTotal} selesai`;
  const pctLabel = document.getElementById('monitor-prog-pct');
  if (pctLabel) pctLabel.textContent = `${pct}%`;

  const sub = document.getElementById('monitor-subtitle');
  if (sub) {
    sub.textContent =
      catShouldStop ? 'Dihentikan.' :
        catDone >= catTotal && catTotal > 0 ? 'Selesai!' :
          `${catTotal - catDone} gambar tersisa…`;
  }
  // Live stats update
  const okEl = document.getElementById('live-ok');
  const emptyEl = document.getElementById('live-empty');
  const failEl = document.getElementById('live-fail');
  if (okEl) okEl.textContent = catRepOk;
  if (emptyEl) emptyEl.textContent = catRepEmpty;
  if (failEl) failEl.textContent = catRepFail;
}

function stopCategorize() {
  catShouldStop = true;
  catRunning = false;
  catPausing = false;
  catPaused = false;
  catQueue = [];
  for (const slot in catControllers) {
    if (catControllers[slot]) {
      try { catControllers[slot].abort(); } catch (_) { }
    }
  }
  catControllers = {};
  const sub = document.getElementById('monitor-subtitle');
  if (sub) sub.textContent = 'Menghentikan secara instan…';
}

function togglePauseCategorize() {
  const btn = document.getElementById('monitor-pause-btn');
  if (!btn) return;

  if (!catPaused && !catPausing) {
    // Start pausing
    catPausing = true;
    btn.disabled = true;
    btn.textContent = 'Pausing...';
    document.getElementById('monitor-subtitle').textContent = 'Menunggu batch saat ini selesai untuk di-pause…';
    if (catActiveWorkers.size === 0) {
      catPaused = true;
      catPausing = false;
      btn.disabled = false;
      btn.textContent = 'Resume';
      btn.className = 'btn btn-accent';
      document.getElementById('monitor-subtitle').textContent = 'Di-pause.';
    }
  } else if (catPaused) {
    // Resume execution
    catPaused = false;
    catPausing = false;
    btn.textContent = 'Pause';
    btn.className = 'btn btn-ghost';
    document.getElementById('monitor-subtitle').textContent = 'Melanjutkan…';
    updateMonitorProgress();

    // Restart active workers
    const batchSize = Math.max(1, parseInt(document.getElementById('cat-batch-size').value) || 4);
    for (let i = 0; i < batchSize; i++) {
      if (!catActiveWorkers.has(i)) {
        runWorker(i);
      }
    }
  }
}

function addRecentResult(filename, status, info) {
  catRecentResults.unshift({ filename, status, info });
  if (catRecentResults.length > 5) catRecentResults.pop();
  renderRecentResults();
}

function renderRecentResults() {
  const wrap = document.getElementById('monitor-recent-wrap');
  const list = document.getElementById('monitor-recent-list');
  if (!wrap || !list) return;

  if (catRecentResults.length === 0) {
    wrap.style.display = 'none';
    return;
  }
  wrap.style.display = 'block';
  list.innerHTML = catRecentResults.map(r => {
    let labelText = '';
    let infoText = '';
    if (r.status === 'ok') {
      labelText = 'SUCCESS';
      infoText = r.info.map(t => `<span class="worker-result-tag" style="margin:0">${esc(t)}</span>`).join(' ');
    } else if (r.status === 'empty') {
      labelText = 'NO TAGS';
      infoText = '<span style="font-style:italic;opacity:.7">tidak ada tag yang relevan</span>';
    } else {
      labelText = 'PARSE FAIL';
      infoText = `<span style="font-family:monospace;color:var(--danger)">${esc(r.info.slice(0, 50))}${r.info.length > 50 ? '…' : ''}</span>`;
    }
    return `
      <div class="recent-item ${r.status}">
        <img class="recent-item-thumb" src="/dataset/${enc(ds.name)}/images/${enc(r.filename)}" alt="" loading="lazy">
        <span style="font-size:0.6rem; font-weight:800; padding:2px 6px; border-radius:4px; background:rgba(0,0,0,0.2); flex-shrink:0">${labelText}</span>
        <span class="recent-item-fn" title="${esc(r.filename)}">${esc(r.filename)}</span>
        <span class="recent-item-info">${infoText}</span>
      </div>`;
  }).join('');
}

let isFetchingMonitorModels = false;
async function onMonitorModelDropdownClick() {
  if (isFetchingMonitorModels) return;
  isFetchingMonitorModels = true;
  const select = document.getElementById('monitor-model-select');
  if (!select) return;
  const currentVal = select.value;
  try {
    const r = await fetch('/api/llm/models');
    if (!r.ok) throw new Error();
    const data = await r.json();
    const models = data.data || [];
    select.innerHTML = '';
    if (!models.length) {
      select.innerHTML = '<option value="">No active models</option>';
      return;
    }
    models.forEach(m => {
      const opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = m.id;
      if (m.id === currentVal) opt.selected = true;
      select.appendChild(opt);
    });
  } catch (_) {
  } finally {
    isFetchingMonitorModels = false;
  }
}

async function onMonitorModelSelectChange() {
  const select = document.getElementById('monitor-model-select');
  if (!select) return;
  const newModel = select.value;
  if (!newModel) return;
  try {
    const s = await fetch('/api/llm-settings').then(r => r.json());
    s.model = newModel;
    await fetch('/api/llm-settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(s)
    });
    toast(`Model diganti ke: ${newModel}`);
  } catch (e) {
    toast(`Gagal mengganti model: ${e.message}`, 'err');
  }
}

function showReport() {
  const okEl = document.getElementById('rep-ok');
  if (okEl) okEl.textContent = catRepOk;
  const emptyEl = document.getElementById('rep-empty');
  if (emptyEl) emptyEl.textContent = catRepEmpty;
  const failEl = document.getElementById('rep-fail');
  if (failEl) failEl.textContent = catRepFail;

  const hasFail = catFailedItems.length > 0;
  const failSection = document.getElementById('rep-failed-section');
  if (failSection) failSection.style.display = hasFail ? '' : 'none';
  const noFailActions = document.getElementById('rep-no-fail-actions');
  if (noFailActions) noFailActions.style.display = hasFail ? 'none' : '';

  if (hasFail) {
    const list = document.getElementById('rep-failed-list');
    if (list) {
      list.innerHTML = catFailedItems.map(item =>
        `<div class="failed-item">
          <svg viewBox="0 0 24 24" style="width:13px;height:13px;fill:var(--danger);flex-shrink:0"><path d="M13,14H11V10H13M13,18H11V16H13M1,21H23L12,2L1,21Z"/></svg>
          <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(item.filename)}</span>
          <code>${esc(item.rawText.slice(0, 60))}${item.rawText.length > 60 ? '…' : ''}</code>
        </div>`
      ).join('');
    }
  }

  const rep = document.getElementById('cat-report');
  if (rep) rep.classList.add('visible');
  // Hide action buttons, show back button
  const bottomActions = document.getElementById('monitor-bottom-actions');
  if (bottomActions) bottomActions.style.display = 'none';
  const doneAction = document.getElementById('monitor-done-action');
  if (doneAction) doneAction.style.display = 'flex';
  // refresh tags in main dataset view & categorize filter
  refreshTagsFilterDropdown();
  refreshCatTagsFilterDropdown();
}

async function retryCategorize() {
  if (!catFailedItems.length) return;
  const retryFiles = catFailedItems.map(i => i.filename);
  catFailedItems = [];
  catRepFail = 0;
  catDone -= retryFiles.length;
  catTotal = retryFiles.length + catQueue.length;
  catQueue = [...retryFiles, ...catQueue];
  catRunning = true;
  catShouldStop = false;
  document.getElementById('cat-report').classList.remove('visible');
  updateMonitorProgress();

  const batchSize = Math.max(1, parseInt(document.getElementById('cat-batch-size').value) || 4);
  const workers = [];
  for (let i = 0; i < Math.min(batchSize, retryFiles.length); i++) {
    workers.push(runWorker(i));
  }
  await Promise.all(workers);
  catRunning = false;
  showReport();
}

function resetCategorize() {
  catSelectedImgs.clear();
  catRunning = false;
  catShouldStop = false;
  catPaused = false;
  catPausing = false;
  catQueue = [];
  catRecentResults = [];
  renderRecentResults();
  document.getElementById('cat-monitor').classList.remove('active');
  document.getElementById('cat-setup').style.display = '';
  document.getElementById('cat-report').classList.remove('visible');
  // Restore action buttons
  const bottomActions = document.getElementById('monitor-bottom-actions');
  if (bottomActions) bottomActions.style.display = 'flex';
  const doneAction = document.getElementById('monitor-done-action');
  if (doneAction) doneAction.style.display = 'none';
  // Reset pause button
  const pBtn = document.getElementById('monitor-pause-btn');
  if (pBtn) { pBtn.disabled = false; pBtn.textContent = 'Pause'; pBtn.className = 'btn btn-ghost'; }
  renderCatGrid();
  updateStartBtn();
}


// ═══════════════════════════════════════════
// AUTO PAGE LOGIC (Semi-Automatic Labeling)
// ═══════════════════════════════════════════
let autoSelectedImgs = new Set();
let autoClsFilter = new Set();
let autoTagsFilter = new Set();
let autoRunning = false;
let autoPaused = false;
let autoQueue = [];
let autoTotal = 0;
let autoDone = 0;
let autoCurrentFilename = '';
let autoHistory = [];
let autoLiveOk = 0;
let autoLiveRetries = 0;
let autoLiveSkipped = 0;
let autoController = null;
let autoClasses = []; // Array of { name: '', color: '', desc: '' }
let autoCurrentPrediction = null; // List of active valid detections
let autoSavedLabels = {}; // in-memory accepted labels: { filename: [{x, y, class_name, color}] }

let autoSysPromptEditing = false;
let autoRetryPromptEditing = false;
let autoMonitorSysPromptEditing = false;
let autoMonitorRetryPromptEditing = false;

const DEFAULT_AUTO_SYS_PROMPT = `You are an advanced computer vision assistant.
Your task is to identify the center coordinates of the objects of the following classes in the image:
{class_list_desc}

For each class, calculate the absolute center coordinates (x, y) of the object, normalized between 0.0 and 1.0 (where 0.0 is top/left and 1.0 is bottom/right).
Return ONLY a valid JSON object matching this exact schema:
{
  "detections": [
    {
      "class": "class_name",
      "x": 0.5,
      "y": 0.5
    }
  ]
}
If no objects are found, return:
{
  "detections": []
}
Do not include any explanation or markdown formatting outside the JSON object.`;

const DEFAULT_AUTO_RETRY_PROMPT = `The previous predictions were incorrect.
The coordinates predicted were:
{prev_predictions}
The squares containing the corresponding detection numbers and class colors were drawn on the output preview image for your reference.
Please re-analyze the image carefully and output the corrected coordinates.
Return only the JSON object:
{
  "detections": [
    {
      "class": "class_name",
      "x": new_x,
      "y": new_y
    }
  ]
}`;

function initAutoPage() {
  autoRunning = false;
  autoPaused = false;

  if (autoClasses.length === 0) {
    autoClasses.push({ name: '', color: '', desc: '' });
  }

  autoSysPromptEditing = false;
  autoRetryPromptEditing = false;
  autoMonitorSysPromptEditing = false;
  autoMonitorRetryPromptEditing = false;

  const sysPromptEl = document.getElementById('auto-sys-prompt');
  const retryPromptEl = document.getElementById('auto-retry-prompt');

  if (sysPromptEl) sysPromptEl.disabled = true;
  if (retryPromptEl) retryPromptEl.disabled = true;

  const sysBtn = document.getElementById('auto-sys-edit-btn');
  const retryBtn = document.getElementById('auto-retry-edit-btn');
  if (sysBtn) { sysBtn.textContent = 'Edit'; sysBtn.classList.remove('editing'); }
  if (retryBtn) { retryBtn.textContent = 'Edit'; retryBtn.classList.remove('editing'); }

  const monSysBtn = document.getElementById('auto-monitor-sys-edit-btn');
  const monRetryBtn = document.getElementById('auto-monitor-retry-edit-btn');
  if (monSysBtn) { monSysBtn.disabled = true; monSysBtn.textContent = 'Edit'; monSysBtn.classList.remove('editing'); }
  if (monRetryBtn) { monRetryBtn.disabled = true; monRetryBtn.textContent = 'Edit'; monRetryBtn.classList.remove('editing'); }

  renderAutoClassRows();
  updateAutoSysPrompt();

  // Set default retry prompt value
  if (retryPromptEl && !retryPromptEl.value.trim()) {
    retryPromptEl.value = DEFAULT_AUTO_RETRY_PROMPT;
  }

  renderAutoGrid();
  buildAutoPills();
  refreshAutoTagsFilterDropdown();
  updateAutoStartBtn();
}

function buildAutoSystemPrompt(classes) {
  const validClasses = classes.filter(c => c.name.trim() && c.color);
  const classListDesc = validClasses.map(c => {
    const desc = c.desc.trim() ? ` (${c.desc.trim()})` : '';
    return `- "${c.name.trim()}"${desc}`;
  }).join('\n');

  return DEFAULT_AUTO_SYS_PROMPT.replace('{class_list_desc}', classListDesc);
}

function updateAutoSysPrompt() {
  if (autoSysPromptEditing) return;
  const ta = document.getElementById('auto-sys-prompt');
  if (ta) ta.value = buildAutoSystemPrompt(autoClasses);
}

function toggleAutoSysPromptEdit() {
  autoSysPromptEditing = !autoSysPromptEditing;
  const ta = document.getElementById('auto-sys-prompt');
  const btn = document.getElementById('auto-sys-edit-btn');
  if (ta && btn) {
    ta.disabled = !autoSysPromptEditing;
    btn.textContent = autoSysPromptEditing ? 'Lock' : 'Edit';
    btn.classList.toggle('editing', autoSysPromptEditing);
    if (autoSysPromptEditing) ta.focus();
    else updateAutoSysPrompt();
  }
}

function toggleAutoRetryPromptEdit() {
  autoRetryPromptEditing = !autoRetryPromptEditing;
  const ta = document.getElementById('auto-retry-prompt');
  const btn = document.getElementById('auto-retry-edit-btn');
  if (ta && btn) {
    ta.disabled = !autoRetryPromptEditing;
    btn.textContent = autoRetryPromptEditing ? 'Lock' : 'Edit';
    btn.classList.toggle('editing', autoRetryPromptEditing);
    if (autoRetryPromptEditing) ta.focus();
  }
}

function toggleAutoMonitorSysEdit() {
  if (!autoPaused) return;
  autoMonitorSysPromptEditing = !autoMonitorSysPromptEditing;
  const ta = document.getElementById('auto-monitor-sys-prompt');
  const btn = document.getElementById('auto-monitor-sys-edit-btn');
  if (ta && btn) {
    ta.disabled = !autoMonitorSysPromptEditing;
    btn.textContent = autoMonitorSysPromptEditing ? 'Lock' : 'Edit';
    btn.classList.toggle('editing', autoMonitorSysPromptEditing);
    if (autoMonitorSysPromptEditing) ta.focus();
  }
}

function toggleAutoMonitorRetryEdit() {
  if (!autoPaused) return;
  autoMonitorRetryPromptEditing = !autoMonitorRetryPromptEditing;
  const ta = document.getElementById('auto-monitor-retry-prompt');
  const btn = document.getElementById('auto-monitor-retry-edit-btn');
  if (ta && btn) {
    ta.disabled = !autoMonitorRetryPromptEditing;
    btn.textContent = autoMonitorRetryPromptEditing ? 'Lock' : 'Edit';
    btn.classList.toggle('editing', autoMonitorRetryPromptEditing);
    if (autoMonitorRetryPromptEditing) ta.focus();
  }
}

function addAutoClassRow(name, color, desc) {
  if (autoClasses.length >= 3) {
    toast('Maksimum 3 target class!', 'err');
    return;
  }
  autoClasses.push({ name: name || '', color: color || '', desc: desc || '' });
  renderAutoClassRows();
  updateAutoSysPrompt();
  updateAutoStartBtn();
}

function removeAutoClassRow(i) {
  autoClasses.splice(i, 1);
  if (autoClasses.length === 0) {
    autoClasses.push({ name: '', color: '', desc: '' });
  }
  renderAutoClassRows();
  updateAutoSysPrompt();
  updateAutoStartBtn();
}

function renderAutoClassRows() {
  const table = document.getElementById('auto-class-rows');
  if (!table) return;

  table.querySelectorAll('.tag-row').forEach(r => r.remove());

  autoClasses.forEach((cls, i) => {
    const row = document.createElement('div');
    row.className = 'tag-row';
    row.style.display = 'grid';
    row.style.gridTemplateColumns = '1fr 1fr 1.5fr auto';
    row.style.gap = '10px';
    row.style.alignItems = 'center';
    row.style.marginBottom = '8px';

    row.innerHTML = `
      <input class="tag-row-inp name-inp" type="text" placeholder="class name" value="${esc(cls.name)}"
        oninput="autoClassRowChange(${i},'name',this.value)">
      <select class="tag-row-inp" onchange="autoClassRowChange(${i},'color',this.value)" style="background:var(--bg-tertiary); cursor:pointer">
        <option value="" disabled ${!cls.color ? 'selected' : ''}>Pilih Warna...</option>
        <option value="merah" ${cls.color === 'merah' ? 'selected' : ''}>Merah (Red)</option>
        <option value="kuning" ${cls.color === 'kuning' ? 'selected' : ''}>Kuning (Yellow)</option>
        <option value="biru" ${cls.color === 'biru' ? 'selected' : ''}>Biru (Blue)</option>
        <option value="hitam" ${cls.color === 'hitam' ? 'selected' : ''}>Hitam (Black)</option>
        <option value="putih" ${cls.color === 'putih' ? 'selected' : ''}>Putih (White)</option>
      </select>
      <input class="tag-row-inp" type="text" placeholder="deskripsi (opsional)" value="${esc(cls.desc)}"
        oninput="autoClassRowChange(${i},'desc',this.value)">
      <button class="tag-row-rm" onclick="removeAutoClassRow(${i})" title="Hapus">×</button>
    `;
    table.appendChild(row);
  });

  const addBtn = document.getElementById('auto-add-row-btn');
  if (addBtn) {
    addBtn.disabled = autoClasses.length >= 3;
  }
}

function autoClassRowChange(i, field, val) {
  if (!autoClasses[i]) return;
  autoClasses[i][field] = val;
  updateAutoSysPrompt();
  updateAutoStartBtn();
}

function updateAutoStartBtn() {
  const startBtn = document.getElementById('auto-start-btn');
  const validClasses = autoClasses.filter(c => c.name.trim() && c.color);
  const hasEmptyFields = autoClasses.some(c => !c.name.trim() || !c.color);

  if (startBtn) {
    startBtn.disabled = validClasses.length === 0 || hasEmptyFields || autoSelectedImgs.size === 0;
  }

  const selLabel = document.getElementById('auto-sel-count');
  if (selLabel) {
    selLabel.textContent = `${autoSelectedImgs.size} dipilih`;
  }
}

function buildAutoPills() {
  const wrap = document.getElementById('auto-pills-wrap');
  if (!wrap || !ds) return;
  wrap.innerHTML = '';

  ds.classes.names.forEach((name, id) => {
    const active = autoClsFilter.has(id);
    const btn = document.createElement('button');
    btn.className = `pill ${active ? 'active' : ''}`;
    btn.style.borderColor = ds.cmap[id]?.color || '#f00';
    btn.innerHTML = `<span class="dot" style="background:${ds.cmap[id]?.color || '#f00'}"></span> ${esc(name)}`;
    btn.onclick = () => {
      if (autoClsFilter.has(id)) autoClsFilter.delete(id);
      else autoClsFilter.add(id);
      buildAutoPills();
      renderAutoGrid();
    };
    wrap.appendChild(btn);
  });
}

function toggleAutoTagsFilterDropdown(event) {
  event.stopPropagation();
  document.getElementById('auto-tags-filter-menu').classList.toggle('show');
}

function refreshAutoTagsFilterDropdown() {
  const menu = document.getElementById('auto-tags-filter-menu');
  if (!menu || !ds) return;

  const counts = {};
  ds.images.forEach(img => {
    (img.tags || []).forEach(t => counts[t] = (counts[t] || 0) + 1);
  });

  const uniqueTags = Object.keys(counts).sort();
  menu.innerHTML = '';

  if (!uniqueTags.length) {
    menu.innerHTML = '<div style="padding:10px 14px;font-size:0.8rem;color:var(--text-muted)">Belum ada tags</div>';
    return;
  }

  uniqueTags.forEach(t => {
    const active = autoTagsFilter.has(t);
    const item = document.createElement('div');
    item.className = `dropdown-menu-item ${active ? 'active' : ''}`;
    item.style.padding = '8px 12px';
    item.style.display = 'flex';
    item.style.alignItems = 'center';
    item.style.gap = '8px';
    item.style.cursor = 'pointer';
    item.innerHTML = `
      <input type="checkbox" ${active ? 'checked' : ''} style="pointer-events:none">
      <span style="flex:1">${esc(t)}</span>
      <span class="badge" style="font-size:0.7rem">${counts[t]}</span>
    `;
    item.onclick = (e) => {
      e.stopPropagation();
      if (autoTagsFilter.has(t)) autoTagsFilter.delete(t);
      else autoTagsFilter.add(t);
      refreshAutoTagsFilterDropdown();
      renderAutoGrid();
    };
    menu.appendChild(item);
  });
}

function getAutoFilteredImgs() {
  if (!ds) return [];
  const searchVal = document.getElementById('hdr-srch')?.value.trim().toLowerCase() || '';
  return ds.images.filter(img => {
    if (searchVal && !img.filename.toLowerCase().includes(searchVal)) return false;

    if (autoClsFilter.size > 0) {
      const imgClasses = (img.annotations || []).map(a => a.class_id);
      const hasMatch = imgClasses.some(cid => autoClsFilter.has(cid));
      if (!hasMatch) return false;
    }

    if (autoTagsFilter.size > 0) {
      const hasMatch = (img.tags || []).some(t => autoTagsFilter.has(t));
      if (!hasMatch) return false;
    }

    return true;
  });
}

function renderAutoGrid() {
  const grid = document.getElementById('auto-grid');
  if (!grid || !ds) return;
  grid.innerHTML = '';

  const imgs = getAutoFilteredImgs();
  if (imgs.length === 0) {
    grid.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:40px;color:var(--text-muted)">Tidak ada gambar yang cocok</div>';
    return;
  }

  imgs.forEach(img => {
    const isSelected = autoSelectedImgs.has(img.filename);
    const card = document.createElement('div');
    card.className = `cat-card ${isSelected ? 'selected' : ''}`;
    card.style.height = '140px';
    card.style.width = '140px';
    card.style.position = 'relative';
    card.style.borderRadius = '8px';
    card.style.overflow = 'hidden';
    card.style.border = '1px solid var(--border)';
    card.style.cursor = 'pointer';
    card.style.background = '#060813';

    let polys = '';
    if (showAnn && img.annotations) {
      polys = img.annotations.map(a => {
        const pts = a.points.map(p => `${p[0]},${p[1]}`).join(' ');
        const col = ds.cmap[a.class_id]?.color || '#f00';
        return `<polygon points="${pts}" fill="${col}" fill-opacity=".33" stroke="${col}" stroke-width=".015"/>`;
      }).join('');
    }

    card.innerHTML = `
      <div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;position:relative">
        <img src="/dataset/${enc(ds.name)}/images/${enc(img.filename)}" style="max-width:100%;max-height:100%;object-fit:contain" loading="lazy">
        <svg viewBox="0 0 1 1" preserveAspectRatio="none" style="position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none">${polys}</svg>
        <div style="position:absolute;top:6px;left:6px;width:16px;height:16px;border-radius:4px;border:1.5px solid var(--text-muted);background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;color:white;font-size:0.6rem">
          ${isSelected ? '✓' : ''}
        </div>
      </div>
      <div style="position:absolute;bottom:0;left:0;right:0;background:rgba(0,0,0,0.7);padding:2px 6px;font-size:0.65rem;text-overflow:ellipsis;white-space:nowrap;overflow:hidden;color:var(--text-secondary)" title="${esc(img.filename)}">
        ${esc(img.filename)}
      </div>
    `;

    if (isSelected) {
      card.style.borderColor = 'var(--accent)';
      const checkbox = card.querySelector('div > div');
      if (checkbox) {
        checkbox.style.background = 'var(--accent)';
        checkbox.style.borderColor = 'var(--accent)';
      }
    }

    card.onclick = () => toggleAutoCard(img.filename);
    grid.appendChild(card);
  });
}

function toggleAutoCard(filename) {
  if (autoSelectedImgs.has(filename)) {
    autoSelectedImgs.delete(filename);
  } else {
    autoSelectedImgs.add(filename);
  }
  renderAutoGrid();
  updateAutoStartBtn();
}

function autoSelectAll() {
  const imgs = getAutoFilteredImgs();
  imgs.forEach(i => autoSelectedImgs.add(i.filename));
  renderAutoGrid();
  updateAutoStartBtn();
}

function autoSelectNone() {
  autoSelectedImgs.clear();
  renderAutoGrid();
  updateAutoStartBtn();
}

function startAutoLabeling() {
  if (autoSelectedImgs.size === 0 || autoClasses.filter(c => c.name.trim() && c.color).length === 0) return;

  autoRunning = true;
  autoPaused = false;
  autoQueue = [...autoSelectedImgs];
  autoTotal = autoQueue.length;
  autoDone = 0;

  autoLiveOk = 0;
  autoLiveRetries = 0;
  autoLiveSkipped = 0;

  document.getElementById('auto-monitor-sys-prompt').value = document.getElementById('auto-sys-prompt').value;
  document.getElementById('auto-monitor-retry-prompt').value = document.getElementById('auto-retry-prompt').value;

  document.getElementById('auto-setup').style.display = 'none';
  const monitorEl = document.getElementById('auto-monitor');
  if (monitorEl) {
    monitorEl.style.display = 'flex';
    monitorEl.classList.add('active');
  }

  updateAutoMonitorProgress();
  processNextAutoImage();
}

function updateAutoMonitorProgress() {
  const pct = autoTotal > 0 ? Math.round(autoDone / autoTotal * 100) : 0;
  const bar = document.getElementById('auto-prog-bar');
  if (bar) bar.style.width = `${pct}%`;

  const doneLabel = document.getElementById('auto-prog-done');
  if (doneLabel) doneLabel.textContent = `${autoDone} / ${autoTotal} selesai`;

  const pctLabel = document.getElementById('auto-prog-pct');
  if (pctLabel) pctLabel.textContent = `${pct}%`;

  const sub = document.getElementById('auto-monitor-subtitle');
  if (sub) {
    sub.textContent =
      !autoRunning ? 'Dihentikan.' :
        autoDone >= autoTotal ? 'Selesai!' :
          `Memproses gambar ${autoDone + 1} dari ${autoTotal}…`;
  }

  document.getElementById('auto-live-ok').textContent = autoLiveOk;
  document.getElementById('auto-live-retries').textContent = autoLiveRetries;
  document.getElementById('auto-live-skipped').textContent = autoLiveSkipped;
}

async function processNextAutoImage() {
  if (!autoRunning) return;

  if (autoPaused) {
    document.getElementById('auto-monitor-subtitle').textContent = 'Di-pause. Edit prompt jika diperlukan lalu klik Resume atau Retry.';
    return;
  }

  if (autoQueue.length === 0) {
    autoRunning = false;
    updateAutoMonitorProgress();
    toast('Semua gambar berhasil diproses!', 'ok');
    return;
  }

  const filename = autoQueue[0];
  autoCurrentFilename = filename;
  autoHistory = [];
  autoCurrentPrediction = null;

  updateAutoMonitorProgress();

  const rawImg = document.getElementById('auto-img-input');
  if (rawImg) {
    rawImg.src = `/dataset/${enc(ds.name)}/images/${enc(filename)}`;
  }

  const previewImg = document.getElementById('auto-img-output');
  if (previewImg) previewImg.src = '';
  document.getElementById('auto-think-panel').innerHTML = 'Menghubungi AI…';
  document.getElementById('auto-answer-panel').textContent = '{}';
  document.getElementById('auto-preview-overlay-info').style.display = 'none';

  document.getElementById('auto-accept-btn').disabled = true;
  document.getElementById('auto-retry-btn').disabled = true;
  document.getElementById('auto-remove-btn').disabled = true;

  callAutoLLM(filename, false);
}

async function callAutoLLM(filename, isRetry = false) {
  if (autoController) {
    try { autoController.abort(); } catch (_) { }
  }

  autoController = new AbortController();

  document.getElementById('auto-img-input-loader').style.display = 'block';
  document.getElementById('auto-img-output-loader').style.display = 'block';

  try {
    const b64Res = await fetch(`/api/dataset/${enc(ds.name)}/image-base64/${enc(filename)}`);
    if (!b64Res.ok) throw new Error('Gagal mengambil base64 gambar');
    const b64Data = await b64Res.json();

    const sysPromptTemplate = document.getElementById('auto-monitor-sys-prompt').value;
    const retryPromptTemplate = document.getElementById('auto-monitor-retry-prompt').value;

    let userPromptText = `Identifikasi koordinat titik tengah dari objek target.`;
    if (isRetry && autoHistory.length > 0) {
      const lastHist = autoHistory[autoHistory.length - 1]; // last list of detections
      const prevPreds = lastHist.map((h, idx) => `- Class "${h.class}" (rendered as a ${h.color} square with index number ${idx + 1} on the output preview) predicted at x=${h.x.toFixed(3)}, y=${h.y.toFixed(3)}`).join('\n');
      userPromptText = retryPromptTemplate
        .replace(/{prev_predictions}/g, prevPreds);
    }

    const messages = [
      { role: 'system', content: sysPromptTemplate },
      {
        role: 'user',
        content: [
          { type: 'text', text: userPromptText },
          {
            type: 'image_url',
            image_url: { url: `data:${b64Data.mime_type};base64,${b64Data.base64}` }
          }
        ]
      }
    ];

    const response = await fetch('/api/llm/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: messages,
        temperature: 0.1,
        stream: true
      }),
      signal: autoController.signal
    });

    if (!response.ok) {
      const errTxt = await response.text();
      throw new Error(`LLM Error: ${errTxt || response.statusText}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';

    let thinkingText = '';
    let contentText = '';

    const thinkPanel = document.getElementById('auto-think-panel');
    const answerPanel = document.getElementById('auto-answer-panel');

    thinkPanel.innerHTML = '';
    answerPanel.textContent = '';

    document.getElementById('auto-img-input-loader').style.display = 'none';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        const cleanLine = line.trim();
        if (!cleanLine.startsWith('data: ')) continue;
        const jsonStr = cleanLine.slice(6);
        if (jsonStr === '[DONE]') break;

        try {
          const parsed = JSON.parse(jsonStr);
          const choice = parsed.choices?.[0];
          if (!choice) continue;

          if (choice.delta?.reasoning_content) {
            thinkingText += choice.delta.reasoning_content;
            thinkPanel.textContent = thinkingText;
            thinkPanel.scrollTop = thinkPanel.scrollHeight;
          }

          if (choice.delta?.content) {
            contentText += choice.delta.content;
            answerPanel.textContent = contentText;
            answerPanel.scrollTop = answerPanel.scrollHeight;
          }
        } catch (_) { }
      }
    }

    document.getElementById('auto-img-output-loader').style.display = 'none';

    const parsedDets = parseAutoDetections(contentText);
    if (parsedDets && parsedDets.length > 0) {
      const validDets = [];
      parsedDets.forEach(d => {
        if (typeof d.x === 'number' && typeof d.y === 'number' && d.class) {
          const targetCls = autoClasses.find(c => c.name.toLowerCase().trim() === d.class.toLowerCase().trim());
          if (targetCls) {
            validDets.push({
              class: targetCls.name,
              x: d.x,
              y: d.y,
              color: targetCls.color
            });
          }
        }
      });

      if (validDets.length > 0) {
        autoCurrentPrediction = validDets;

        const previewImg = document.getElementById('auto-img-output');
        if (previewImg) {
          const t = Date.now();
          const detectionsParam = encodeURIComponent(JSON.stringify(validDets));
          previewImg.src = `/api/dataset/${enc(ds.name)}/auto-preview?filename=${enc(filename)}&detections=${detectionsParam}&t=${t}`;
        }

        const overlayInfo = document.getElementById('auto-preview-overlay-info');
        if (overlayInfo) {
          overlayInfo.style.display = 'block';
          overlayInfo.textContent = validDets.map(d => `${d.class}: (${d.x.toFixed(2)}, ${d.y.toFixed(2)})`).join(', ');
        }

        document.getElementById('auto-accept-btn').disabled = false;
      } else {
        thinkPanel.innerHTML += `<div style="color:var(--danger);margin-top:10px">Gagal mencocokkan deteksi dengan target class.</div>`;
        document.getElementById('auto-accept-btn').disabled = true;
      }
    } else {
      thinkPanel.innerHTML += `<div style="color:var(--danger);margin-top:10px">Gagal mem-parsing format detections dari respon AI.</div>`;
      document.getElementById('auto-accept-btn').disabled = true;
    }

    document.getElementById('auto-retry-btn').disabled = false;
    document.getElementById('auto-remove-btn').disabled = false;

  } catch (err) {
    document.getElementById('auto-img-input-loader').style.display = 'none';
    document.getElementById('auto-img-output-loader').style.display = 'none';

    if (err.name !== 'AbortError') {
      toast(`Error processing image: ${err.message}`, 'err');
      document.getElementById('auto-think-panel').innerHTML = `<span style="color:var(--danger)">Error: ${esc(err.message)}</span>`;
      document.getElementById('auto-retry-btn').disabled = false;
      document.getElementById('auto-remove-btn').disabled = false;
    }
  }
}

function parseAutoDetections(text) {
  if (!text) return null;

  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;

  try {
    const obj = JSON.parse(jsonMatch[0]);
    if (obj && Array.isArray(obj.detections)) {
      return obj.detections;
    }
  } catch (_) { }


  return null;
}

async function autoAcceptCurrent() {
  if (!autoCurrentFilename || !autoCurrentPrediction) return;

  try {
    const res = await fetch(`/api/dataset/${enc(ds.name)}/save-annotations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filename: autoCurrentFilename,
        annotations: autoCurrentPrediction
      })
    });
    const data = await res.json();
    if (!res.ok || !data.success) {
      throw new Error(data.detail || 'Gagal menyimpan ke server');
    }

    // Update local dataset object memory so the mask/labels show up immediately
    const imgObj = ds.images.find(img => img.filename === autoCurrentFilename);
    if (imgObj) {
      imgObj.annotations = autoCurrentPrediction.map(ann => {
        const classIdx = ds.classes.names.indexOf(ann.class);
        return {
          class_id: classIdx !== -1 ? classIdx : 0,
          points: [[ann.x, ann.y]]
        };
      });
    }

    if (annData) {
      const annImgObj = annData.images.find(img => img.filename === autoCurrentFilename);
      if (annImgObj) {
        annImgObj.annotations = autoCurrentPrediction.map(ann => {
          const classIdx = ds.classes.names.indexOf(ann.class);
          return {
            class_id: classIdx !== -1 ? classIdx : 0,
            points: [[ann.x, ann.y]]
          };
        });
      }
    }

    autoSavedLabels[autoCurrentFilename] = autoCurrentPrediction;
    autoLiveOk++;
    autoDone++;

    autoQueue.shift();
    processNextAutoImage();
  } catch (err) {
    toast(`Gagal menyimpan label: ${err.message}`, 'err');
  }
}

function autoRemoveCurrent() {
  if (!autoCurrentFilename) return;

  autoLiveSkipped++;
  autoDone++;

  autoQueue.shift();
  processNextAutoImage();
}

function autoRetryCurrent() {
  if (!autoCurrentFilename) return;

  autoLiveRetries++;

  if (autoCurrentPrediction) {
    autoHistory.push(autoCurrentPrediction);
  } else {
    autoHistory.push([]);
  }

  document.getElementById('auto-think-panel').innerHTML = 'Mengulang analisa dengan konteks koreksi…';
  document.getElementById('auto-answer-panel').textContent = '{}';
  document.getElementById('auto-preview-overlay-info').style.display = 'none';

  document.getElementById('auto-accept-btn').disabled = true;
  document.getElementById('auto-retry-btn').disabled = true;
  document.getElementById('auto-remove-btn').disabled = true;

  callAutoLLM(autoCurrentFilename, true);
}

function togglePauseAuto() {
  const btn = document.getElementById('auto-pause-btn');
  const badge = document.getElementById('auto-prompt-status-badge');

  const sysTa = document.getElementById('auto-monitor-sys-prompt');
  const retryTa = document.getElementById('auto-monitor-retry-prompt');
  const sysBtn = document.getElementById('auto-monitor-sys-edit-btn');
  const retryBtn = document.getElementById('auto-monitor-retry-edit-btn');

  if (!btn) return;

  if (!autoPaused) {
    autoPaused = true;
    btn.textContent = 'Resume';
    btn.className = 'btn btn-accent';
    if (badge) {
      badge.textContent = 'PAUSED';
      badge.style.background = 'var(--danger)';
    }
    if (sysBtn) sysBtn.disabled = false;
    if (retryBtn) retryBtn.disabled = false;

    document.getElementById('auto-monitor-subtitle').textContent = 'Di-pause. Silakan klik Edit pada panel kanan untuk mengedit prompt, lalu klik Resume atau Retry.';
  } else {
    autoPaused = false;
    btn.textContent = 'Pause';
    btn.className = 'btn btn-ghost';
    if (badge) {
      badge.textContent = 'ACTIVE';
      badge.style.background = 'var(--success)';
    }

    autoMonitorSysPromptEditing = false;
    autoMonitorRetryPromptEditing = false;
    if (sysTa) sysTa.disabled = true;
    if (retryTa) retryTa.disabled = true;
    if (sysBtn) { sysBtn.disabled = true; sysBtn.textContent = 'Edit'; sysBtn.classList.remove('editing'); }
    if (retryBtn) { retryBtn.disabled = true; retryBtn.textContent = 'Edit'; retryBtn.classList.remove('editing'); }

    updateAutoMonitorProgress();
    processNextAutoImage();
  }
}

function stopAutoLabeling() {
  autoRunning = false;
  autoPaused = false;
  autoQueue = [];

  if (autoController) {
    try { autoController.abort(); } catch (_) { }
    autoController = null;
  }

  document.getElementById('auto-monitor').style.display = 'none';
  document.getElementById('auto-monitor').classList.remove('active');
  document.getElementById('auto-setup').style.display = '';

  const btn = document.getElementById('auto-pause-btn');
  if (btn) {
    btn.textContent = 'Pause';
    btn.className = 'btn btn-ghost';
  }

  renderAutoGrid();
  updateAutoStartBtn();
}

window.autoSelectAll = autoSelectAll;
window.autoSelectNone = autoSelectNone;
window.toggleAutoTagsFilterDropdown = toggleAutoTagsFilterDropdown;
window.togglePauseAuto = togglePauseAuto;
window.autoRemoveCurrent = autoRemoveCurrent;
window.autoRetryCurrent = autoRetryCurrent;
window.autoAcceptCurrent = autoAcceptCurrent;
window.stopAutoLabeling = stopAutoLabeling;
window.startAutoLabeling = startAutoLabeling;
window.updateAutoStartBtn = updateAutoStartBtn;
window.initAutoPage = initAutoPage;
window.addAutoClassRow = addAutoClassRow;
window.removeAutoClassRow = removeAutoClassRow;
window.autoClassRowChange = autoClassRowChange;
window.toggleAutoSysPromptEdit = toggleAutoSysPromptEdit;
window.toggleAutoRetryPromptEdit = toggleAutoRetryPromptEdit;
window.toggleAutoMonitorSysEdit = toggleAutoMonitorSysEdit;
window.toggleAutoMonitorRetryEdit = toggleAutoMonitorRetryEdit;
window.toggleClassFilterDropdown = toggleClassFilterDropdown;
window.toggleLabeledFilterDropdown = toggleLabeledFilterDropdown;
window.setLabeledFilter = setLabeledFilter;
window.toggleTagsFilterDropdown = toggleTagsFilterDropdown;


