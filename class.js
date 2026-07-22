// ═══════════════════════════════════════════
// CLASS SETTINGS & TAGS MANAGER (Modularized)
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
          <span class="tag-name-label" style="font-weight:600;color:var(--text-primary)"></span>
          <div style="display:flex;align-items:center;gap:12px">
            <span class="badge">${t.count} gambar</span>
            <button class="btn btn-ghost delete-tag-btn" style="padding: 4px; color: var(--danger)">
              <svg viewBox="0 0 24 24" style="width:16px;height:16px;fill:currentColor"><path d="M19,4H15.5L14.5,3H9.5L8.5,4H5V6H19M6,19A2,2 0 0,0 8,21H16A2,2 0 0,0 18,19V7H6V19Z"/></svg>
            </button>
          </div>`;
        row.querySelector('.tag-name-label').textContent = t.name;
        row.querySelector('.delete-tag-btn').onclick = () => deleteTag(t.name);
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
