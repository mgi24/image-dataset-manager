// ═══════════════════════════════════════════
// CATEGORIZE LOGIC (Modularized)
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
document.addEventListener('click', (event) => {
  const el = document.getElementById('cat-tags-filter-menu');
  const btn = document.getElementById('cat-tags-filter-btn');
  if (el && !el.contains(event.target) && btn && !btn.contains(event.target)) {
    el.classList.remove('show');
  }
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
