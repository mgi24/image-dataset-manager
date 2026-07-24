// ═══════════════════════════════════════════
// DATASET & LLM SETTINGS (Modularized)
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
      const autoLayeringChk = document.getElementById('set-auto-layering');
      if (autoLayeringChk) autoLayeringChk.checked = !!s.auto_layering;
    })
    .catch(() => { });
  checkSamModelStatus();
}

async function saveLLMSettings() {
  try {
    const r = await fetch('/api/llm-settings');
    const s = r.ok ? await r.json() : {};
    
    s.api_url = document.getElementById('set-api-url').value.trim() || 'http://127.0.0.1:1234';
    s.api_key = document.getElementById('set-api-key').value.trim();
    s.model = document.getElementById('set-model').value.trim();
    const dsTypeSel = document.getElementById('set-dataset-type');
    if (dsTypeSel) s.dataset_type = dsTypeSel.value;
    
    const r2 = await fetch('/api/llm-settings', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(s)
    });
    const d = await r2.json();
    if (d.success) toast('Settings tersimpan!');
  } catch (e) {
    toast(`Error: ${e.message}`, 'err');
  }
}

async function saveDatasetSettings() {
  try {
    const r = await fetch('/api/llm-settings');
    const s = r.ok ? await r.json() : {};
    
    const dsTypeSel = document.getElementById('set-dataset-type');
    if (dsTypeSel) s.dataset_type = dsTypeSel.value;
    
    const r2 = await fetch('/api/llm-settings', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(s)
    });
    const d = await r2.json();
    if (d.success) toast('Dataset settings berhasil disimpan!');
  } catch (e) {
    toast(`Error: ${e.message}`, 'err');
  }
}

async function toggleAutoLayering(checked) {
  try {
    const r = await fetch('/api/llm-settings');
    if (r.ok) {
      const s = await r.json();
      s.auto_layering = checked;
      await fetch('/api/llm-settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(s)
      });
      toast('Auto layering updated!');
    }
  } catch (e) {
    toast(`Failed to update auto layering: ${e.message}`, 'err');
  }
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

async function checkSamModelStatus() {
  const listEl = document.getElementById('sam-model-status-list');
  const unloadBtn = document.getElementById('set-sam-unload-btn');
  if (!listEl) return;

  try {
    const r = await fetch('/api/sam/status');
    if (!r.ok) throw new Error('Network error');
    const data = await r.json();

    const loadedPoint = data.loaded_point_models || [];
    const loadedAuto = data.loaded_auto_models || [];
    const loadedYolo = data.loaded_yolo_models || [];

    if (loadedPoint.length === 0 && loadedAuto.length === 0 && loadedYolo.length === 0) {
      listEl.innerHTML = '<span style="color: var(--text-muted); font-size: 0.85rem;">Tidak ada model SAM atau YOLO yang aktif di memori.</span>';
      if (unloadBtn) unloadBtn.disabled = true;
    } else {
      let html = '';
      if (loadedPoint.length > 0) {
        html += `<div style="font-size: 0.85rem; color: var(--text-primary); margin-bottom: 4px;">Point Predictor: <code style="color: var(--accent-light); font-weight: 700;">${loadedPoint.join(', ')}</code></div>`;
      }
      if (loadedAuto.length > 0) {
        html += `<div style="font-size: 0.85rem; color: var(--text-primary); margin-bottom: 4px;">Auto Predictor: <code style="color: var(--accent-light); font-weight: 700;">${loadedAuto.join(', ')}</code></div>`;
      }
      if (loadedYolo.length > 0) {
        html += `<div style="font-size: 0.85rem; color: var(--text-primary);">YOLO Detector: <code style="color: #fdba74; font-weight: 700;">${loadedYolo.join(', ')}</code></div>`;
      }
      listEl.innerHTML = html;
      if (unloadBtn) unloadBtn.disabled = false;
    }
  } catch (e) {
    listEl.innerHTML = `<span style="color: var(--danger); font-size: 0.85rem;">Gagal memeriksa status: ${esc(e.message)}</span>`;
  }
}

async function unloadSamModels() {
  const unloadBtn = document.getElementById('set-sam-unload-btn');
  if (unloadBtn) unloadBtn.disabled = true;
  showLoader(true, 'Membebaskan memori model...');
  try {
    const r = await fetch('/api/sam/unload', { method: 'POST' });
    if (!r.ok) throw new Error('Failed to unload');
    const data = await r.json();
    toast('Semua model SAM & YOLO berhasil di-unload dari memori!');
    await checkSamModelStatus();
  } catch (e) {
    toast(`Gagal unload model: ${e.message}`, 'err');
    if (unloadBtn) unloadBtn.disabled = false;
  } finally {
    showLoader(false);
  }
}
