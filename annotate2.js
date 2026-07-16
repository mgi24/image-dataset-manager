(function () {
  'use strict';

  // ── State ──
  let _ds = null;
  let _images = [];
  let _idx = 0;
  let _imgEl = null;
  let _anns = [];        // [{class_id, points, type:'bbox'|'polygon', locked}]
  let _selIdx = -1;
  let _tool = 'drag';
  let _tags = [];
  let _curTags = [];
  let _datasetType = 'object_detection'; // default setting
  let _autosave = false;
  let _hoverIdx = -1;

  // Magic Selection state
  let _magicPts = [];           // [{x, y, label}]  label=1 pos, 0 neg
  let _magicPreview = null;     // [{x,y}] normalised polygon preview
  let _magicLoading = false;

  // Canvas transform
  let _pan = { x: 0, y: 0 };
  let _scale = 1;

  // Interaction state
  let _panning = false, _panStart = null;
  let _drawing = false, _drawStart = null;
  let _polyPts = [];
  let _mouseImg = null;
  let _polySnap = false;
  let _dragAnn = false, _dragAnnStart = null, _dragAnnOrig = null;
  let _dragCorner = -1, _dragCornerOrig = null;

  const MIN_BBOX = 0.005;

  // ── Public init ──
  window.initAnn2 = function (dsState, imgList) {
    _ds = dsState;
    _images = imgList || [];
    _idx = 0;
    _buildClassSel();

    // Fetch settings first to configure tools based on Dataset Type
    Promise.all([_fetchTags(), _fetchDatasetSettings()]).then(() => {
      _setTool('drag');
      _setupCanvas();
      _setupKeys();
      if (_images.length > 0) _loadImg(0);
      else _drawEmpty();
    });
  };

  async function _fetchDatasetSettings() {
    try {
      const r = await fetch('/api/llm-settings');
      if (r.ok) {
        const s = await r.json();
        _datasetType = s.dataset_type || 'object_detection';
        _autosave = !!s.autosave;
        const chk = document.getElementById('ann2-autosave-chk');
        if (chk) chk.checked = _autosave;
      }
    } catch (e) {
      _datasetType = 'object_detection';
      _autosave = false;
    }

    // Visually disable or hide restricted buttons
    const btnBbox = document.getElementById('ann2-tool-bbox');
    const btnPoly = document.getElementById('ann2-tool-polygon');

    if (_datasetType === 'segment') {
      if (btnBbox) btnBbox.style.display = 'none';
      if (btnPoly) btnPoly.style.display = 'flex';
    } else {
      if (btnBbox) btnBbox.style.display = 'flex';
      if (btnPoly) btnPoly.style.display = 'none';
    }
  }

  function _buildClassSel() {
    const sel = document.getElementById('ann2-class-sel');
    const menu = document.getElementById('ann2-premium-sel-menu');
    if (!sel || !menu || !_ds) return;

    menu.innerHTML = '';

    const defOpt = document.createElement('div');
    defOpt.style.cssText = 'display:flex; align-items:center; gap:8px; padding:6px 10px; cursor:pointer; border-radius:6px; font-size:.82rem; color:var(--text-primary); transition:background 0.15s;';
    defOpt.onmouseover = () => { defOpt.style.background = 'var(--bg-tertiary)'; };
    defOpt.onmouseout = () => { defOpt.style.background = 'transparent'; };
    defOpt.innerHTML = `<span style="width:10px;height:10px;border-radius:50%;background:transparent;display:inline-block;border:1px solid rgba(255,255,255,0.1);flex-shrink:0;"></span> <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">— pilih —</span>`;
    defOpt.onclick = (e) => { ann2SetClassVal('', e); };
    menu.appendChild(defOpt);

    (_ds.classes?.names || []).forEach((n, i) => {
      const col = _clsColor(i);
      const opt = document.createElement('div');
      opt.style.cssText = 'display:flex; align-items:center; gap:8px; padding:6px 10px; cursor:pointer; border-radius:6px; font-size:.82rem; color:var(--text-primary); transition:background 0.15s;';
      opt.onmouseover = () => { opt.style.background = 'var(--bg-tertiary)'; };
      opt.onmouseout = () => { opt.style.background = 'transparent'; };
      opt.innerHTML = `<span style="width:10px;height:10px;border-radius:50%;background:${col};display:inline-block;border:1px solid rgba(255,255,255,0.2);flex-shrink:0;"></span> <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${n}</span>`;
      opt.onclick = (e) => { ann2SetClassVal(i, e); };
      menu.appendChild(opt);
    });

    sel.removeEventListener('change', _onClassChange);
    sel.addEventListener('change', _onClassChange);
    _onClassChange();
  }

  function _updateClassDotColor() {
    const sel = document.getElementById('ann2-class-sel');
    const dot = document.getElementById('ann2-class-color-dot');
    const text = document.getElementById('ann2-class-sel-text');
    if (!sel || !dot || !text) return;
    const cid = parseInt(sel.value);
    if (isNaN(cid)) {
      dot.style.background = 'transparent';
      dot.style.borderColor = 'transparent';
      text.textContent = '— pilih —';
    } else {
      const col = _clsColor(cid);
      dot.style.background = col;
      dot.style.borderColor = 'rgba(255,255,255,0.2)';
      text.textContent = _ds?.classes?.names[cid] || `#${cid}`;
    }
  }

  function _onClassChange() {
    _updateClassDotColor();
    const sel = document.getElementById('ann2-class-sel');
    if (!sel) return;
    const cid = parseInt(sel.value);
    if (_tool === 'edit' && _selIdx >= 0 && _anns[_selIdx]) {
      if (!isNaN(cid) && !_anns[_selIdx].locked) {
        if (_anns[_selIdx].class_id !== cid) {
          _anns[_selIdx].class_id = cid;
          _redraw();
          _renderAnnList();
          if (_autosave) {
            ann2Save();
          }
        }
      }
    }
  }

  window.ann2ToggleClassMenu = function (e) {
    e.stopPropagation();
    const menu = document.getElementById('ann2-premium-sel-menu');
    const trigger = document.getElementById('ann2-premium-sel-trigger');
    if (menu.style.display === 'none') {
      menu.style.display = 'flex';
      trigger.style.boxShadow = '0 0 16px rgba(239, 68, 68, 0.4)';
      trigger.style.borderColor = 'rgba(239, 68, 68, 0.8)';
    } else {
      menu.style.display = 'none';
      trigger.style.boxShadow = '0 0 12px rgba(239, 68, 68, 0.25)';
      trigger.style.borderColor = 'rgba(239, 68, 68, 0.4)';
    }
  };

  window.ann2SetClassVal = function (val, e) {
    if (e) e.stopPropagation();
    const sel = document.getElementById('ann2-class-sel');
    if (sel) {
      sel.value = val;
      sel.dispatchEvent(new Event('change'));
    }
    const menu = document.getElementById('ann2-premium-sel-menu');
    if (menu) menu.style.display = 'none';
    const trigger = document.getElementById('ann2-premium-sel-trigger');
    if (trigger) {
      trigger.style.boxShadow = '0 0 12px rgba(239, 68, 68, 0.25)';
      trigger.style.borderColor = 'rgba(239, 68, 68, 0.4)';
    }
  };

  async function _fetchTags() {
    try {
      const r = await fetch('/api/tags');
      _tags = await r.json();
      if (typeof window._renderTagSelect === 'function') window._renderTagSelect();
    }
    catch (e) { _tags = []; }
  }

  function _drawEmpty() {
    const c = document.getElementById('ann2-canvas');
    const w = document.getElementById('ann2-canvas-wrap');
    if (!c || !w) return;
    c.width = w.clientWidth; c.height = w.clientHeight;
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.fillStyle = 'rgba(255,255,255,.25)';
    ctx.font = '15px Outfit,sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('No images in annotate/ folder', c.width / 2, c.height / 2);
  }

  // ── Image Loading ──
  async function _loadImg(idx) {
    _idx = Math.max(0, Math.min(idx, _images.length - 1));
    const imgObj = _images[_idx];
    _anns = (imgObj.annotations || []).map(a => ({
      class_id: a.class_id,
      points: a.points.map(p => [...p]),
      type: a.points.length === 2 ? 'bbox' : 'polygon',
      locked: false
    }));
    _selIdx = -1;
    const ctr = document.getElementById('ann2-img-counter');
    if (ctr) ctr.textContent = `${_idx + 1} / ${_images.length}`;
    await _fetchImgTags(imgObj.filename);
    _renderTagsArea();
    _imgEl = new Image();
    _imgEl.onload = () => { _fitImg(); _redraw(); _renderAnnList(); };
    _imgEl.onerror = () => { _imgEl = null; _redraw(); };
    _imgEl.src = `/dataset/${encodeURIComponent(_ds.name)}/annotate/images/${encodeURIComponent(imgObj.filename)}`;
  }

  async function _fetchImgTags(filename) {
    try {
      const r = await fetch(`/api/dataset/${encodeURIComponent(_ds.name)}/image-tags/${encodeURIComponent(filename)}`);
      _curTags = r.ok ? (await r.json()).tags || [] : [];
    } catch (e) { _curTags = []; }
  }

  // ── Canvas Setup ──
  function _setupCanvas() {
    const c = document.getElementById('ann2-canvas');
    const wrap = document.getElementById('ann2-canvas-wrap');
    if (!c || !wrap) return;
    new ResizeObserver(() => { if (_imgEl) { _fitImg(); _redraw(); } else { c.width = wrap.clientWidth; c.height = wrap.clientHeight; } }).observe(wrap);
    c.addEventListener('mousedown', _onDown);
    c.addEventListener('mousemove', _onMove);
    c.addEventListener('mouseup', _onUp);
    c.addEventListener('mouseleave', _onLeave);
    c.addEventListener('wheel', _onWheel, { passive: false });
    c.addEventListener('dblclick', _onDbl);
    c.addEventListener('contextmenu', e => { e.preventDefault(); if (_tool === 'polygon') _cancelPoly(); });
    document.addEventListener('click', e => {
      const menu = document.getElementById('ann2-premium-sel-menu');
      const trigger = document.getElementById('ann2-premium-sel-trigger');
      if (menu && trigger && !menu.contains(e.target) && !trigger.contains(e.target)) {
        menu.style.display = 'none';
        trigger.style.boxShadow = '0 0 12px rgba(239, 68, 68, 0.25)';
        trigger.style.borderColor = 'rgba(239, 68, 68, 0.4)';
      }
    });
  }

  function _setupKeys() {
    document.addEventListener('keydown', e => {
      const root = document.getElementById('ann2-root');
      if (!root || root.closest('[style*="display:none"]')) return;
      const tag = e.target.tagName.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
      const k = e.key;
      if (k === 'h' || k === 'H') _setTool('drag');
      if ((k === 'b' || k === 'B') && _datasetType !== 'segment') _setTool('bbox');
      if ((k === 'p' || k === 'P') && _datasetType !== 'object_detection') _setTool('polygon');
      if (k === 'e' || k === 'E') _setTool('edit');
      if (k === 'm' || k === 'M') _setTool('magic');
      if (k === 'ArrowLeft') ann2Prev();
      if (k === 'ArrowRight') ann2Next();
      if ((e.ctrlKey || e.metaKey) && k === 's') { e.preventDefault(); ann2Save(); }
      if (k === 'Enter' && _tool === 'polygon' && _polyPts.length >= 3) _closePoly();
      if (k === 'Enter' && _tool === 'magic' && _magicPreview && _magicPreview.length >= 3) { e.preventDefault(); _confirmMagic(); }
      if (k === 'Escape') {
        if (_tool === 'polygon') _cancelPoly();
        if (_tool === 'magic') _cancelMagic();
        _selIdx = -1; _redraw(); _renderAnnList();
      }
      if ((k === 'Delete' || k === 'Backspace') && _selIdx >= 0 && !_anns[_selIdx]?.locked) {
        _anns.splice(_selIdx, 1); _selIdx = -1; _redraw(); _renderAnnList();
      }
    });
  }

  // ── Tool ──
  function _setTool(t) {
    if (t === 'bbox' && _datasetType === 'segment') return;
    if (t === 'polygon' && _datasetType === 'object_detection') return;

    _cancelPoly();
    _cancelMagic();
    _drawing = false; _polyPts = [];
    _tool = t;
    _hoverIdx = -1;
    document.querySelectorAll('.ann2-tool-btn').forEach(b => b.classList.remove('active-tool'));
    const btn = document.getElementById(`ann2-tool-${t}`);
    if (btn) btn.classList.add('active-tool');
    const c = document.getElementById('ann2-canvas');
    if (c) c.style.cursor = t === 'drag' ? 'grab' : 'crosshair';

    const hint = document.getElementById('ann2-hint-text');
    if (hint) {
      if (t === 'polygon') {
        hint.textContent = 'Enter = close selection · Esc = cancel';
        hint.style.color = 'var(--accent-light)';
        hint.style.fontSize = '.78rem';
        hint.style.fontWeight = '600';
      } else if (t === 'edit') {
        hint.textContent = 'Click to select · Drag control points to edit';
        hint.style.color = 'var(--accent-light)';
        hint.style.fontSize = '.78rem';
        hint.style.fontWeight = '600';
      } else if (t === 'magic') {
        hint.textContent = 'Click = positive · Ctrl+Click = negative · Enter = konfirmasi · Esc = batal';
        hint.style.color = '#a78bfa';
        hint.style.fontSize = '.78rem';
        hint.style.fontWeight = '600';
      } else {
        hint.textContent = 'Scroll = zoom · H = pan';
        hint.style.color = 'var(--text-muted)';
        hint.style.fontSize = '.7rem';
        hint.style.fontWeight = 'normal';
      }
    }
    _redraw();
  }
  window.ann2SetTool = _setTool;

  // ── Coords ──
  function _c2i(cx, cy) {
    if (!_imgEl || !_imgEl.naturalWidth || !_imgEl.naturalHeight || !_scale) return { x: 0, y: 0 };
    return { x: (cx - _pan.x) / (_imgEl.naturalWidth * _scale), y: (cy - _pan.y) / (_imgEl.naturalHeight * _scale) };
  }
  function _i2c(ix, iy) {
    if (!_imgEl) return { x: 0, y: 0 };
    return { x: ix * _imgEl.naturalWidth * _scale + _pan.x, y: iy * _imgEl.naturalHeight * _scale + _pan.y };
  }
  function _clp(v) { return Math.max(0, Math.min(1, v)); }

  // ── Hit ──
  function _hitTest(ix, iy) {
    for (let i = 0; i < _anns.length; i++) {
      const a = _anns[i]; if (a.locked) continue;
      if (a.type === 'bbox') {
        const [[x1, y1], [x2, y2]] = a.points;
        if (ix >= Math.min(x1, x2) && ix <= Math.max(x1, x2) && iy >= Math.min(y1, y2) && iy <= Math.max(y1, y2)) return i;
      } else {
        if (_ptInPoly(ix, iy, a.points)) return i;
      }
    }
    return -1;
  }
  function _hitCorner(cx, cy, ann) {
    if (!ann || ann.locked) return -1;
    if (ann.type === 'bbox') {
      if (ann.points.length < 2) return -1;
      const [[x1, y1], [x2, y2]] = ann.points;
      const corners = [
        _i2c(Math.min(x1, x2), Math.min(y1, y2)),
        _i2c(Math.max(x1, x2), Math.min(y1, y2)),
        _i2c(Math.max(x1, x2), Math.max(y1, y2)),
        _i2c(Math.min(x1, x2), Math.max(y1, y2))
      ];
      for (let i = 0; i < corners.length; i++) {
        const dx = cx - corners[i].x, dy = cy - corners[i].y;
        if (dx * dx + dy * dy <= 64) return i;
      }
    } else if (ann.type === 'polygon') {
      for (let i = 0; i < ann.points.length; i++) {
        const c = _i2c(ann.points[i][0], ann.points[i][1]);
        const dx = cx - c.x, dy = cy - c.y;
        if (dx * dx + dy * dy <= 64) return i;
      }
    }
    return -1;
  }
  function _ptInPoly(px, py, pts) {
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const xi = pts[i][0], yi = pts[i][1], xj = pts[j][0], yj = pts[j][1];
      if (((yi > py) !== (yj > py)) && (px < (xj - xi) * (py - yi) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
  }

  // ── Mouse Handlers ──
  function _onDown(e) {
    if (e.button !== 0) return;
    const rect = e.target.getBoundingClientRect();
    const cx = e.clientX - rect.left, cy = e.clientY - rect.top;
    const ip = _c2i(cx, cy);

    if (_tool === 'drag') {
      _panning = true; _panStart = { mx: cx, my: cy, px: _pan.x, py: _pan.y };
      e.target.style.cursor = 'grabbing'; return;
    }

    if (_tool === 'magic') {
      const cid = parseInt(document.getElementById('ann2-class-sel')?.value);
      if (isNaN(cid) || !_ds?.classes?.names[cid]) {
        if (window.toast) toast('Pilih class terlebih dahulu', 'err');
        return;
      }
      if (_magicLoading) return;
      const label = e.ctrlKey ? 0 : 1;
      _magicPts.push({ x: _clp(ip.x), y: _clp(ip.y), label });
      _redraw();
      _runMagicPredict();
      return;
    }

    if (_tool === 'edit') {
      if (_selIdx >= 0 && _anns[_selIdx]) {
        const ci = _hitCorner(cx, cy, _anns[_selIdx]);
        if (ci >= 0) { _dragCorner = ci; _dragCornerOrig = _anns[_selIdx].points.map(p => [...p]); return; }
      }
      const hi = _hitTest(ip.x, ip.y);
      if (hi >= 0) {
        _selIdx = hi;
        const sel = document.getElementById('ann2-class-sel');
        if (sel && _anns[hi]) {
          sel.value = _anns[hi].class_id;
          if (typeof _updateClassDotColor === 'function') _updateClassDotColor();
        }
        if (!_anns[hi].locked) { _dragAnn = true; _dragAnnStart = { x: ip.x, y: ip.y }; _dragAnnOrig = _anns[hi].points.map(p => [...p]); }
        _redraw(); _renderAnnList(); return;
      } else {
        _selIdx = -1; _redraw(); _renderAnnList(); return;
      }
    }

    const cid = parseInt(document.getElementById('ann2-class-sel')?.value);
    if (isNaN(cid) || !_ds?.classes?.names[cid]) {
      if (window.toast) toast('Pilih class terlebih dahulu', 'err');
      _selIdx = -1; _redraw(); _renderAnnList(); return;
    }
    if (_tool === 'bbox') { _drawing = true; _drawStart = { x: _clp(ip.x), y: _clp(ip.y) }; return; }
    if (_tool === 'polygon') {
      if (!_drawing) { _drawing = true; _polyPts = []; }

      if (_drawing && _polyPts.length >= 3) {
        const firstPt = _i2c(_polyPts[0][0], _polyPts[0][1]);
        const mc = _i2c(_clp(ip.x), _clp(ip.y));
        const dx = mc.x - firstPt.x, dy = mc.y - firstPt.y;
        if (dx * dx + dy * dy <= 144) {
          _closePoly(); return;
        }
      }
      _polyPts.push([_clp(ip.x), _clp(ip.y)]); _redraw(); return;
    }
  }

  function _onMove(e) {
    const rect = e.target.getBoundingClientRect();
    const cx = e.clientX - rect.left, cy = e.clientY - rect.top;
    const ip = _c2i(cx, cy);
    _mouseImg = ip;

    if (!_panning && _dragCorner === -1 && !_dragAnn && !_drawing) {
      _hoverIdx = _hitTest(ip.x, ip.y);
    }

    if (_panning && _panStart) { _pan.x = _panStart.px + (cx - _panStart.mx); _pan.y = _panStart.py + (cy - _panStart.my); _redraw(); return; }
    if (_dragCorner >= 0 && _dragCornerOrig && _selIdx >= 0) {
      const a = _anns[_selIdx]; if (!a || a.locked) return;
      const o = _dragCornerOrig, np = o.map(p => [...p]);
      const ix = _clp(ip.x), iy = _clp(ip.y);
      if (a.type === 'bbox') {
        if (_dragCorner === 0) { np[0] = [ix, iy]; }
        else if (_dragCorner === 1) { np[0] = [o[0][0], iy]; np[1] = [ix, o[1][1]]; }
        else if (_dragCorner === 2) { np[1] = [ix, iy]; }
        else if (_dragCorner === 3) { np[0] = [ix, o[0][1]]; np[1] = [o[1][0], iy]; }
      } else {
        np[_dragCorner] = [ix, iy];
      }
      a.points = np; _redraw(); return;
    }
    if (_dragAnn && _dragAnnStart && _dragAnnOrig && _selIdx >= 0) {
      const dx = ip.x - _dragAnnStart.x, dy = ip.y - _dragAnnStart.y;
      _anns[_selIdx].points = _dragAnnOrig.map(p => [_clp(p[0] + dx), _clp(p[1] + dy)]);
      _redraw(); return;
    }
    if (_drawing) _redraw();
    if (_selIdx >= 0 && _anns[_selIdx] && !_anns[_selIdx].locked) {
      const ci = _hitCorner(cx, cy, _anns[_selIdx]);
      if (ci >= 0) {
        e.target.style.cursor = _anns[_selIdx].type === 'bbox' ? ['nw-resize', 'ne-resize', 'se-resize', 'sw-resize'][ci] : 'move';
        return;
      }
    }
    e.target.style.cursor = _tool === 'drag' ? 'grab' : 'crosshair';
    if (_tool === 'edit') _redraw();
  }

  function _onUp(e) {
    if (_panning) { _panning = false; e.target.style.cursor = 'grab'; return; }
    if (_dragCorner >= 0) { _dragCorner = -1; _dragCornerOrig = null; return; }
    if (_dragAnn) { _dragAnn = false; _dragAnnStart = null; _dragAnnOrig = null; return; }
    if (_drawing && _tool === 'bbox' && _drawStart && _mouseImg) {
      const x1 = Math.min(_drawStart.x, _clp(_mouseImg.x)), y1 = Math.min(_drawStart.y, _clp(_mouseImg.y));
      const x2 = Math.max(_drawStart.x, _clp(_mouseImg.x)), y2 = Math.max(_drawStart.y, _clp(_mouseImg.y));
      if ((x2 - x1) > MIN_BBOX && (y2 - y1) > MIN_BBOX) {
        const cid = parseInt(document.getElementById('ann2-class-sel')?.value);
        if (!isNaN(cid) && _ds?.classes?.names[cid]) {
          _anns.push({ class_id: cid, points: [[x1, y1], [x2, y2]], type: 'bbox', locked: false });
          _selIdx = _anns.length - 1; _renderAnnList();
        }
      }
      _drawing = false; _drawStart = null; _redraw();
    }
  }

  function _onLeave(e) {
    if (_panning) { _panning = false; e.target.style.cursor = _tool === 'drag' ? 'grab' : 'crosshair'; }
    _mouseImg = null; _hoverIdx = -1; if (_drawing || _tool === 'edit') _redraw();
  }

  function _onDbl() { if (_tool === 'polygon' && _polyPts.length >= 3) _closePoly(); }

  function _onWheel(e) {
    e.preventDefault();
    const rect = e.target.getBoundingClientRect();
    const cx = e.clientX - rect.left, cy = e.clientY - rect.top;
    const f = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    const ns = Math.max(0.05, Math.min(20, _scale * f));
    const r = ns / _scale;
    _pan.x = cx - r * (cx - _pan.x); _pan.y = cy - r * (cy - _pan.y);
    _scale = ns; _redraw();
  }

  // ── Polygon ──
  function _closePoly() {
    if (_polyPts.length < 3) { _cancelPoly(); return; }
    const cid = parseInt(document.getElementById('ann2-class-sel')?.value);
    if (!isNaN(cid) && _ds?.classes?.names[cid]) {
      _anns.push({ class_id: cid, points: _polyPts.map(p => [...p]), type: 'polygon', locked: false });
      _selIdx = _anns.length - 1; _renderAnnList();
    }
    _cancelPoly();
  }
  function _cancelPoly() {
    _drawing = false; _polyPts = [];
    _redraw();
  }

  // ── Magic Selection ──
  function _cancelMagic() {
    _magicPts = [];
    _magicPreview = null;
    _magicLoading = false;
    _redraw();
  }

  function _confirmMagic() {
    if (!_magicPreview || _magicPreview.length < 3) return;
    const cid = parseInt(document.getElementById('ann2-class-sel')?.value);
    if (isNaN(cid) || !_ds?.classes?.names[cid]) {
      if (window.toast) toast('Pilih class terlebih dahulu', 'err');
      return;
    }
    _anns.push({ class_id: cid, points: _magicPreview.map(p => [p[0], p[1]]), type: 'polygon', locked: false });
    _selIdx = _anns.length - 1;
    _renderAnnList();
    _magicPts = [];
    _magicPreview = null;
    _magicLoading = false;
    _redraw();
    if (_autosave) ann2Save();
  }

  async function _runMagicPredict() {
    if (!_ds || !_images.length) return;
    const imgObj = _images[_idx];
    _magicLoading = true;
    _redraw();
    try {
      const resp = await fetch(`/api/dataset/${encodeURIComponent(_ds.name)}/sam-predict`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: imgObj.filename, points: _magicPts })
      });
      const data = await resp.json();
      if (resp.ok && data.success && data.polygons && data.polygons.length > 0) {
        _magicPreview = data.polygons[0]; // array of [x,y]
      } else {
        if (window.toast) toast(data.error || 'SAM gagal menghasilkan mask', 'err');
        _magicPreview = null;
      }
    } catch (err) {
      if (window.toast) toast('SAM error: ' + err.message, 'err');
      _magicPreview = null;
    }
    _magicLoading = false;
    _redraw();
  }

  // ── Redraw ──
  function _redraw() {
    const canvas = document.getElementById('ann2-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setLineDash([]);
    if (!_imgEl || !_imgEl.naturalWidth || !_imgEl.naturalHeight) return;
    ctx.drawImage(_imgEl, _pan.x, _pan.y, _imgEl.naturalWidth * _scale, _imgEl.naturalHeight * _scale);

    // Dimming overlay for Edit Mode
    if (_tool === 'edit') {
      ctx.save();
      ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
      ctx.beginPath();
      // Outer rect
      ctx.rect(0, 0, canvas.width, canvas.height);

      const hoverAnn = _hoverIdx >= 0 ? _anns[_hoverIdx] : (_selIdx >= 0 ? _anns[_selIdx] : null);
      if (hoverAnn) {
        if (hoverAnn.type === 'bbox') {
          const [[x1, y1], [x2, y2]] = hoverAnn.points;
          const c1 = _i2c(Math.min(x1, x2), Math.min(y1, y2)), c2 = _i2c(Math.max(x1, x2), Math.max(y1, y2));
          ctx.rect(c1.x, c1.y, c2.x - c1.x, c2.y - c1.y);
        } else {
          hoverAnn.points.forEach((p, pi) => {
            const c = _i2c(p[0], p[1]);
            if (pi === 0) ctx.moveTo(c.x, c.y);
            else ctx.lineTo(c.x, c.y);
          });
          ctx.closePath();
        }
      }
      ctx.fill('evenodd');
      ctx.restore();
    }

    for (let idx = _anns.length - 1; idx >= 0; idx--) {
      const ann = _anns[idx];
      const sel = idx === _selIdx;
      const col = _clsColor(ann.class_id);
      ctx.save();
      ctx.globalAlpha = ann.locked ? 0.4 : (sel ? 1 : 0.78);
      ctx.strokeStyle = col; ctx.lineWidth = sel ? 2.5 : 1.5;
      if (ann.type === 'bbox') {
        const [[x1, y1], [x2, y2]] = ann.points;
        const c1 = _i2c(Math.min(x1, x2), Math.min(y1, y2)), c2 = _i2c(Math.max(x1, x2), Math.max(y1, y2));
        ctx.strokeRect(c1.x, c1.y, c2.x - c1.x, c2.y - c1.y);
        ctx.fillStyle = col + '22'; ctx.fillRect(c1.x, c1.y, c2.x - c1.x, c2.y - c1.y);
        if (sel && !ann.locked) {
          [[c1.x, c1.y], [c2.x, c1.y], [c2.x, c2.y], [c1.x, c2.y]].forEach(([px, py]) => {
            ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(px, py, 5, 0, Math.PI * 2); ctx.fill();
            ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.stroke();
          });
        }
      } else {
        if (ann.points.length >= 2) {
          ctx.beginPath();
          ann.points.forEach((p, pi) => { const c = _i2c(p[0], p[1]); pi === 0 ? ctx.moveTo(c.x, c.y) : ctx.lineTo(c.x, c.y); });
          ctx.closePath(); ctx.stroke();
          ctx.fillStyle = col + '22'; ctx.fill();
          if (sel && !ann.locked) ann.points.forEach(p => {
            const c = _i2c(p[0], p[1]);
            ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(c.x, c.y, 5, 0, Math.PI * 2); ctx.fill();
            ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.stroke();
          });
        }
      }
      // Label
      const lp = ann.type === 'bbox' ? [Math.min(ann.points[0][0], ann.points[1][0]), Math.min(ann.points[0][1], ann.points[1][1])] : ann.points[0] && [ann.points[0][0], ann.points[0][1]];
      if (lp) {
        const lc = _i2c(lp[0], lp[1]);
        const nm = _ds?.classes?.names[ann.class_id] || `#${ann.class_id}`;
        ctx.globalAlpha = 1; ctx.font = 'bold 11px Outfit,sans-serif';
        const tw = ctx.measureText(nm).width;
        ctx.fillStyle = col; ctx.fillRect(lc.x, lc.y - 14, tw + 8, 15);
        ctx.fillStyle = '#fff'; ctx.fillText(nm, lc.x + 4, lc.y - 2);
      }
      ctx.restore();
    }

    // In-progress bbox
    if (_drawing && _tool === 'bbox' && _drawStart && _mouseImg) {
      const c1 = _i2c(_drawStart.x, _drawStart.y), c2 = _i2c(_clp(_mouseImg.x), _clp(_mouseImg.y));
      ctx.save(); ctx.strokeStyle = _selColor(); ctx.lineWidth = 1.5; ctx.setLineDash([5, 3]);
      ctx.strokeRect(Math.min(c1.x, c2.x), Math.min(c1.y, c2.y), Math.abs(c2.x - c1.x), Math.abs(c2.y - c1.y));
      ctx.restore();
    }

    // In-progress polygon
    if (_drawing && _tool === 'polygon' && _polyPts.length > 0) {
      const col = _selColor();

      _polySnap = false;
      if (_mouseImg && _polyPts.length >= 3) {
        const firstPt = _i2c(_polyPts[0][0], _polyPts[0][1]);
        const mc = _i2c(_clp(_mouseImg.x), _clp(_mouseImg.y));
        const dx = mc.x - firstPt.x, dy = mc.y - firstPt.y;
        if (dx * dx + dy * dy <= 144) _polySnap = true;
      }

      ctx.save(); ctx.strokeStyle = col; ctx.lineWidth = 1.5;
      ctx.beginPath();
      _polyPts.forEach((p, pi) => { const c = _i2c(p[0], p[1]); pi === 0 ? ctx.moveTo(c.x, c.y) : ctx.lineTo(c.x, c.y); });
      if (_mouseImg) {
        const mc = _polySnap ? _i2c(_polyPts[0][0], _polyPts[0][1]) : _i2c(_clp(_mouseImg.x), _clp(_mouseImg.y));
        ctx.lineTo(mc.x, mc.y);
      }
      ctx.stroke();
      _polyPts.forEach((p, pi) => {
        const c = _i2c(p[0], p[1]);
        if (pi === 0 && _polySnap) {
          ctx.fillStyle = '#fbbf24';
          ctx.beginPath(); ctx.arc(c.x, c.y, 8, 0, Math.PI * 2); ctx.fill();
          ctx.strokeStyle = '#f59e0b'; ctx.lineWidth = 2; ctx.stroke();
        } else {
          ctx.fillStyle = pi === 0 ? '#fff' : col; ctx.beginPath(); ctx.arc(c.x, c.y, pi === 0 ? 5 : 3.5, 0, Math.PI * 2); ctx.fill();
          ctx.strokeStyle = col; ctx.lineWidth = 1.5; stroke();
        }
      });
      ctx.restore();
    }

    // Magic Selection overlay (points + preview polygon + spinner)
    _drawMagicOverlay(ctx);
  }

  function _clsColor(id) {
    if (_ds?.classes?.color && _ds.classes.color[id]) return _ds.classes.color[id];
    return ['#6366f1', '#ef4444', '#f59e0b', '#10b981', '#06b6d4', '#a855f7'][id % 6];
  }
  function _selColor() {
    const cid = parseInt(document.getElementById('ann2-class-sel')?.value);
    return isNaN(cid) ? '#6366f1' : _clsColor(cid);
  }

  // ── Magic Selection Overlay Draw ──
  function _drawMagicOverlay(ctx) {
    if (_tool !== 'magic') return;

    // Draw preview polygon
    if (_magicPreview && _magicPreview.length >= 2) {
      const col = _selColor();
      ctx.save();
      ctx.strokeStyle = col;
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 3]);
      ctx.beginPath();
      _magicPreview.forEach((p, pi) => {
        const c = _i2c(p[0], p[1]);
        pi === 0 ? ctx.moveTo(c.x, c.y) : ctx.lineTo(c.x, c.y);
      });
      ctx.closePath();
      ctx.stroke();
      ctx.fillStyle = col + '33';
      ctx.fill();
      ctx.restore();
    }

    // Loading spinner arc
    if (_magicLoading) {
      const cx = document.getElementById('ann2-canvas').width / 2;
      const cy = document.getElementById('ann2-canvas').height / 2;
      ctx.save();
      ctx.strokeStyle = '#a78bfa';
      ctx.lineWidth = 3;
      ctx.lineCap = 'round';
      const t = (Date.now() % 1000) / 1000;
      ctx.beginPath();
      ctx.arc(cx, cy, 20, t * Math.PI * 2, t * Math.PI * 2 + Math.PI * 1.2);
      ctx.stroke();
      ctx.restore();
      requestAnimationFrame(_redraw);
    }

    // Draw placed points
    _magicPts.forEach(pt => {
      const c = _i2c(pt.x, pt.y);
      ctx.save();
      ctx.beginPath();
      ctx.arc(c.x, c.y, 7, 0, Math.PI * 2);
      ctx.fillStyle = pt.label === 1 ? '#22c55e' : '#ef4444';
      ctx.fill();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2;
      ctx.stroke();
      // + or - symbol
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 10px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(pt.label === 1 ? '+' : '−', c.x, c.y);
      ctx.restore();
    });
  }

  // ── Ann List ──
  function _renderAnnList() {
    const list = document.getElementById('ann2-ann-list');
    const cntEl = document.getElementById('ann2-ann-count');
    if (!list) return;
    if (cntEl) cntEl.textContent = _anns.length;
    list.innerHTML = '';
    _anns.forEach((ann, idx) => {
      const col = _clsColor(ann.class_id);
      const name = _ds?.classes?.names[ann.class_id] || `#${ann.class_id}`;
      const item = document.createElement('div');
      item.className = 'ann2-ann-item' + (idx === _selIdx ? ' ann2-selected' : '') + (ann.locked ? ' ann2-locked' : '');

      // HTML5 Drag & Drop for reordering layers
      item.draggable = true;
      item.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/plain', idx);
        item.classList.add('dragging');
      });
      item.addEventListener('dragover', (e) => {
        e.preventDefault();
        const draggingItem = list.querySelector('.dragging');
        if (!draggingItem) return;
        const siblings = [...list.querySelectorAll('.ann2-ann-item:not(.dragging)')];
        const nextSibling = siblings.find(sibling => {
          return e.clientY <= sibling.getBoundingClientRect().top + sibling.getBoundingClientRect().height / 2;
        });
        if (nextSibling) {
          list.insertBefore(draggingItem, nextSibling);
        } else {
          list.appendChild(draggingItem);
        }
      });
      item.addEventListener('drop', (e) => {
        e.preventDefault();
        const fromIdx = parseInt(e.dataTransfer.getData('text/plain'));
        const draggingItem = list.querySelector('.dragging');
        if (!draggingItem) return;
        const currentItems = [...list.querySelectorAll('.ann2-ann-item')];
        const toIdx = currentItems.indexOf(draggingItem);
        if (fromIdx !== toIdx && fromIdx >= 0 && toIdx >= 0) {
          const [moved] = _anns.splice(fromIdx, 1);
          _anns.splice(toIdx, 0, moved);
          _selIdx = toIdx;
          _redraw();
        }
      });
      item.addEventListener('dragend', () => {
        item.classList.remove('dragging');
        _renderAnnList();
      });

      item.onclick = () => {
        _selIdx = idx;
        const sel = document.getElementById('ann2-class-sel');
        if (sel && ann) {
          sel.value = ann.class_id;
          if (typeof _updateClassDotColor === 'function') _updateClassDotColor();
        }
        _redraw();
        _renderAnnList();
      };

      const dot = document.createElement('span');
      dot.style.cssText = 'cursor:grab;margin-right:4px;display:inline-flex;align-items:center;flex-shrink:0;';
      dot.innerHTML = `<svg viewBox="0 0 24 24" style="width:14px;height:14px;fill:${col};"><path d="M9,5a1.5,1.5,0,1,1-1.5-1.5A1.5,1.5,0,0,1,9,5Zm0,5.5a1.5,1.5,0,1,0,1.5,1.5A1.5,1.5,0,0,0,9,10.5Zm0,5.5a1.5,1.5,0,1,0,1.5,1.5A1.5,1.5,0,0,0,9,16Zm6-11a1.5,1.5,0,1,0-1.5-1.5A1.5,1.5,0,0,0,15,5Zm0,5.5a1.5,1.5,0,1,0,1.5,1.5A1.5,1.5,0,0,0,15,10.5Zm0,5.5a1.5,1.5,0,1,0,1.5,1.5A1.5,1.5,0,0,0,15,16Z"/></svg>`;

      const typeEl = document.createElement('span');
      typeEl.style.cssText = 'color:var(--text-muted);font-size:.68rem;flex-shrink:0;';
      typeEl.textContent = ann.type === 'bbox' ? '▭' : '⬡';
      const nameEl = document.createElement('span');
      nameEl.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
      nameEl.textContent = name;
      const lockBtn = document.createElement('button');
      lockBtn.className = 'ann2-icon-btn'; lockBtn.title = ann.locked ? 'Unlock' : 'Lock';
      lockBtn.innerHTML = ann.locked
        ? '<svg viewBox="0 0 24 24" style="width:12px;height:12px;fill:currentColor"><path d="M18,8A2,2 0 0,1 20,10V20A2,2 0 0,1 18,22H6A2,2 0 0,1 4,20V10C4,8.89 4.9,8 6,8H15V6A3,3 0 0,0 12,3A3,3 0 0,0 9,6H7A5,5 0 0,1 12,1A5,5 0 0,1 17,6V8H18M12,17A2,2 0 0,0 14,15A2,2 0 0,0 12,13A2,2 0 0,0 10,15A2,2 0 0,0 12,17Z"/></svg>'
        : '<svg viewBox="0 0 24 24" style="width:12px;height:12px;fill:currentColor"><path d="M18,8A2,2 0 0,1 20,10V20A2,2 0 0,1 18,22H6A2,2 0 0,1 4,20V10A2,2 0 0,1 6,8H13V6A3,3 0 0,0 10,3A3,3 0 0,0 7,6H5A5,5 0 0,1 10,1A5,5 0 0,1 15,6V8H18M12,17A2,2 0 0,0 14,15A2,2 0 0,0 12,13A2,2 0 0,0 10,15A2,2 0 0,0 12,17Z"/></svg>';
      lockBtn.onclick = ev => { ev.stopPropagation(); ann.locked = !ann.locked; _redraw(); _renderAnnList(); };
      const delBtn = document.createElement('button');
      delBtn.className = 'ann2-del-btn'; delBtn.title = 'Hapus';
      delBtn.innerHTML = '<svg viewBox="0 0 24 24" style="width:11px;height:11px;fill:currentColor"><path d="M19,4H15.5L14.5,3H9.5L8.5,4H5V6H19M6,19A2,2 0 0,0 8,21H16A2,2 0 0,0 18,19V7H6V19Z"/></svg>';
      delBtn.onclick = ev => {
        ev.stopPropagation(); if (ann.locked) return;
        _anns.splice(idx, 1); if (_selIdx >= idx) _selIdx = Math.max(-1, _selIdx - 1);
        _redraw(); _renderAnnList();
      };
      item.append(dot, typeEl, nameEl, lockBtn, delBtn);
      list.appendChild(item);
    });
  }

  // ── Tags ──
  function _renderTagsArea() {
    const area = document.getElementById('ann2-tags-area');
    if (!area) return;
    area.innerHTML = '';
    _curTags.forEach(tag => {
      const chip = document.createElement('span');
      chip.className = 'ann2-tag-chip';
      const t = document.createTextNode(tag);
      const btn = document.createElement('button');
      btn.textContent = '×'; btn.onclick = () => { _curTags = _curTags.filter(x => x !== tag); _renderTagsArea(); };
      chip.appendChild(t); chip.appendChild(btn);
      area.appendChild(chip);
    });
    if (typeof window._renderTagSelect === 'function') window._renderTagSelect();
  }

  window._renderTagSelect = function () {
    const sel = document.getElementById('ann2-tag-sel');
    if (!sel) return;
    sel.innerHTML = '<option value="">+ Tambah tag...</option>';
    _tags.forEach(t => {
      if (!_curTags.includes(t.name)) {
        const opt = document.createElement('option');
        opt.value = t.name; opt.textContent = t.name;
        sel.appendChild(opt);
      }
    });
  };

  window.ann2AddSelectedTag = function (sel) {
    const val = sel.value;
    if (val && !_curTags.includes(val)) {
      _curTags.push(val);
      _renderTagsArea();
    }
    sel.value = '';
  };

  // ── Navigation ──
  window.ann2Prev = () => {
    if (_autosave) {
      ann2Save().then(() => { if (_idx > 0) _loadImg(_idx - 1); });
    } else {
      if (_idx > 0) _loadImg(_idx - 1);
    }
  };
  window.ann2Next = () => {
    if (_autosave) {
      ann2Save().then(() => { if (_idx < _images.length - 1) _loadImg(_idx + 1); });
    } else {
      if (_idx < _images.length - 1) _loadImg(_idx + 1);
    }
  };

  // ── Save ──
  window.ann2Save = async function () {
    if (!_ds || !_images.length) return;
    const imgObj = _images[_idx];
    const btn = document.getElementById('ann2-save-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    let labelContent = '';
    _anns.forEach(ann => {
      const pts = ann.points.flat().map(v => v.toFixed(6)).join(' ');
      labelContent += `${ann.class_id} ${pts}\n`;
    });
    try {
      const r = await fetch(`/api/dataset/${encodeURIComponent(_ds.name)}/annotate/save-label`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: imgObj.filename, label: labelContent })
      });
      if (!r.ok) throw new Error('Save failed');
      imgObj.annotations = _anns.map(a => ({ class_id: a.class_id, points: a.points.map(p => [...p]) }));
      if (window.toast) toast('Tersimpan ✓');
    } catch (e) {
      if (window.toast) toast('Gagal: ' + e.message, 'err');
    }
    if (btn) { btn.disabled = false; btn.innerHTML = '<svg viewBox="0 0 24 24" style="width:13px;height:13px;fill:currentColor;margin-right:4px"><path d="M15,9H5V5H15M12,19A3,3 0 0,1 9,16A3,3 0 0,1 12,13A3,3 0 0,1 15,16A3,3 0 0,1 12,19M17,3H5C3.89,3 3,3.89 3,5V19A2,2 0 0,0 5,21H19A2,2 0 0,0 21,19V7L17,3Z"/></svg>Save (Ctrl+S)'; }
  };

  window.ann2ToggleAutosave = async function (checked) {
    _autosave = checked;
    try {
      const r = await fetch('/api/llm-settings');
      if (r.ok) {
        const s = await r.json();
        s.autosave = checked;
        await fetch('/api/llm-settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(s)
        });
      }
    } catch (e) {
      console.error("Failed to save autosave setting", e);
    }
  };

})();
