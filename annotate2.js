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
  let _originalTags = [];
  let _datasetType = 'object_detection'; // default setting
  let _autosave = false;
  let _autoLayering = false;
  let _hoverIdx = -1;

  // Magic Selection state
  let _magicPts = [];           // [{x, y, label}]  label=1 pos, 0 neg
  let _magicPreview = null;     // [{x,y}] normalised polygon preview
  let _magicLoading = false;
  let _magicReplaceIdx = -1;    // index of _anns to replace on confirm (-1 = add new)

  // Auto Annotate state
  let _autoAnnotateActive = false;
  let _autoAnnotateSettings = { model: 'sam3.1', prompts: [], on_approved_tags: [], conf: 0.25, iou: 0.85, recheck_imgsz: 1024, yolo_entries: [] };
  let _autoProcessing = false;
  let _autoApprovedTags = [];  // local editable copy for panel
  let _tempAutoAnns = [];      // temporary scan-only polygons for preview
  let _tempAnnHoverIdx = -1;   // hover index into _tempAutoAnns
  let _tempAnnSelIdx = -1;     // selected index into _tempAutoAnns
  let _tempAnnDragVertex = -1; // vertex index being dragged in selected temp ann (-1 = none)
  let _tempAnnDragVertStart = null;  // {x,y} image coords at drag start
  let _iouRejectedAnns = [];   // polygons rejected during last scan due to IoU
  let _showIouRejected = false; // whether to display iou-rejected outlines
  let _simplifyDirty = false;   // whether simplify slider has been moved from 100
  let _tempAnnOrigPts = null;   // original points of selected temp ann before simplify preview
  let _settingsDirty = false;
  let _settingsSnapshot = null;  // deep clone at time of open, for cancel-revert
  let _magicSettingsDirty = false;
  let _magicSettingsSnapshot = null;
  // YOLO model class cache: { modelKey: [classNames] }
  let _yoloClassCache = {};
  let _gpuList = [{ id: 'cuda:0', name: 'CUDA:0' }];

  // Canvas transform
  let _pan = { x: 0, y: 0 };
  let _scale = 1;

  // Undo/Redo state
  let _undoStack = [];
  let _redoStack = [];
  let _beforeEditSnapshot = null;

  // Selected vertex inside temporary auto-annotated preview
  let _tempAnnSelectedVertex = -1;
  let _activeSimplifyTargetKey = null;

  // Interaction state
  let _panning = false, _panStart = null;
  let _drawing = false, _drawStart = null;
  let _shiftHeld = false;
  let _polyPts = [];
  let _mouseImg = null;
  let _polySnap = false;
  let _dragAnn = false, _dragAnnStart = null, _dragAnnOrig = null;
  let _dragCorner = -1, _dragCornerOrig = null;

  const MIN_BBOX = 0.005;

  // ── Public init ──
  window.initAnn2 = function (dsState, imgList, startIdx = 0) {
    _ds = dsState;
    _images = imgList || [];
    _idx = Math.max(0, Math.min(startIdx, _images.length - 1));
    _buildClassSel();

    // Fetch settings first to configure tools based on Dataset Type
    Promise.all([_fetchTags(), _fetchDatasetSettings()]).then(() => {
      _setTool('drag');
      _setupCanvas();
      _setupKeys();
      if (_images.length > 0) _loadImg(_idx);
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
        _autoLayering = !!s.auto_layering;
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
          _pushUndoState();
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
  function _getAnnArea(ann) {
    if (ann.type === 'bbox') {
      if (ann.points.length < 2) return 0;
      const [[x1, y1], [x2, y2]] = ann.points;
      return Math.abs(x2 - x1) * Math.abs(y2 - y1);
    } else if (ann.type === 'polygon') {
      let area = 0;
      const pts = ann.points;
      const n = pts.length;
      for (let i = 0; i < n; i++) {
        const p1 = pts[i];
        const p2 = pts[(i + 1) % n];
        area += p1[0] * p2[1] - p2[0] * p1[1];
      }
      return Math.abs(area) / 2;
    }
    return 0;
  }

  function _applyAutoLayering() {
    if (!_autoLayering || _anns.length <= 1) return;
    const originalOrder = _anns.map((a, i) => ({ ann: a, index: i, area: _getAnnArea(a) }));
    const sortedOrder = [...originalOrder].sort((a, b) => a.area - b.area);
    let changed = false;
    for (let i = 0; i < sortedOrder.length; i++) {
      if (sortedOrder[i].index !== i) {
        changed = true;
        break;
      }
    }
    if (changed) {
      _anns = sortedOrder.map(o => o.ann);
      ann2Save();
    }
  }

  async function _loadImg(idx) {
    _idx = Math.max(0, Math.min(idx, _images.length - 1));
    if (_ds && typeof window.navigate === 'function') {
      window.navigate(`/${encodeURIComponent(_ds.name)}/annotate2/${_idx}`, true);
    }
    _tempAutoAnns = [];
    _tempAnnSelectedVertex = -1;
    _activeSimplifyTargetKey = null;
    _undoStack = [];
    _redoStack = [];
    _beforeEditSnapshot = null;
    _updateShortcutHints();
    const imgObj = _images[_idx];
    _anns = (imgObj.annotations || []).map(a => ({
      class_id: a.class_id,
      points: a.points.map(p => [...p]),
      type: a.points.length === 2 ? 'bbox' : 'polygon',
      locked: false
    }));
    _applyAutoLayering();
    _selIdx = -1;
    const ctr = document.getElementById('ann2-img-counter');
    if (ctr) ctr.textContent = `${_idx + 1} / ${_images.length}`;
    await _fetchImgTags(imgObj.filename);
    _renderTagsArea();
    _imgEl = new Image();
    _imgEl.onload = () => {
      setTimeout(() => {
        _fitImg();
        _redraw();
        _renderAnnList();
      }, 50);
    };
    _imgEl.onerror = () => { _imgEl = null; _redraw(); };
    _imgEl.src = `/dataset/${encodeURIComponent(_ds.name)}/annotate/images/${encodeURIComponent(imgObj.filename)}`;
  }

  async function _fetchImgTags(filename) {
    try {
      const r = await fetch(`/api/dataset/${encodeURIComponent(_ds.name)}/image-tags/${encodeURIComponent(filename)}`);
      _curTags = r.ok ? (await r.json()).tags || [] : [];
      _originalTags = [..._curTags];
    } catch (e) {
      _curTags = [];
      _originalTags = [];
    }
  }

  function _fitImg() {
    const wrap = document.getElementById('ann2-canvas-wrap');
    const c = document.getElementById('ann2-canvas');
    if (!wrap || !c || !_imgEl || !_imgEl.naturalWidth || !_imgEl.naturalHeight) return;
    c.width = wrap.clientWidth; c.height = wrap.clientHeight;
    const sx = c.width / _imgEl.naturalWidth, sy = c.height / _imgEl.naturalHeight;
    _scale = Math.min(sx, sy) * 0.92;
    _pan.x = (c.width - _imgEl.naturalWidth * _scale) / 2;
    _pan.y = (c.height - _imgEl.naturalHeight * _scale) / 2;
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
    c.addEventListener('auxclick', e => { if (e.button === 1) e.preventDefault(); });
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
      if (!root) return;
      const page = document.getElementById('page-annotate2');
      if (!page || page.style.display === 'none') return;
      const tag = e.target.tagName.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return;

      if (e.key === 'Shift') {
        if (!_shiftHeld) {
          _shiftHeld = true;
          _redraw();
        }
      }

      const k = e.key;
      const isZ = k.toLowerCase() === 'z' || e.code === 'KeyZ';
      const isY = k.toLowerCase() === 'y' || e.code === 'KeyY';

      if (k === 'h' || k === 'H') _setTool('drag');
      if ((k === 'b' || k === 'B') && _datasetType !== 'segment') _setTool('bbox');
      if ((k === 'p' || k === 'P') && _datasetType !== 'object_detection') _setTool('polygon');
      if (k === 'e' || k === 'E') _setTool('edit');
      if (k === 'm' || k === 'M') _setTool('magic');
      if ((e.ctrlKey || e.metaKey) && isZ) {
        e.preventDefault();
        _undo();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && (isY || (e.shiftKey && isZ))) {
        e.preventDefault();
        _redo();
        return;
      }
      if (k === 'ArrowLeft') ann2Prev();
      if (k === 'ArrowRight') ann2Next();
      if ((e.ctrlKey || e.metaKey) && k === 's') { e.preventDefault(); ann2Save(); }
      if (k === 'Enter' && _tool === 'polygon' && _polyPts.length >= 3) _closePoly();
      if (k === 'Enter' && _tool === 'magic' && _magicPreview && _magicPreview.length >= 3) { e.preventDefault(); _confirmMagic(); }
      if (k === 'Enter' && _tool === 'autoann' && _tempAutoAnns.length > 0) { e.preventDefault(); _confirmTempAutoAnns(); }
      if (k === 'Escape') {
        if (_tool === 'polygon') _cancelPoly();
        if (_tool === 'magic') _cancelMagic();
        if (_tool === 'autoann' && _tempAutoAnns.length > 0) {
          if (_tempAnnSelIdx >= 0) {
            _tempAnnSelIdx = -1;
            _tempAnnSelectedVertex = -1;
            _updateShortcutHints(); _redraw(); return;
          }
          _clearTempAutoAnns();
        }
        _selIdx = -1; _redraw(); _renderAnnList(); _updateShortcutHints();
      }
      // Auto Annotate shortcuts
      if (_tool === 'autoann' && !_autoProcessing) {
        if (k === 's' || k === 'S') { e.preventDefault(); ann2StartAutoAnnotate(); }
      }
      // Delete selected temp ann or vertex in review mode
      if ((k === 'Delete' || k === 'Backspace') && _tool === 'autoann' && _tempAnnSelIdx >= 0) {
        const ann = _tempAutoAnns[_tempAnnSelIdx];
        if (ann && _tempAnnSelectedVertex >= 0 && _tempAnnSelectedVertex < ann.points.length) {
          if (ann.points.length <= 3) {
            _tempAutoAnns.splice(_tempAnnSelIdx, 1);
            _tempAnnSelIdx = -1;
            _tempAnnHoverIdx = -1;
            _tempAnnSelectedVertex = -1;
          } else {
            ann.points.splice(_tempAnnSelectedVertex, 1);
            _tempAnnSelectedVertex = -1;
          }
          _redraw();
          _updateShortcutHints();
        } else {
          _tempAutoAnns.splice(_tempAnnSelIdx, 1);
          _tempAnnSelIdx = -1; _tempAnnHoverIdx = -1;
          _tempAnnSelectedVertex = -1;
          _updateShortcutHints(); _redraw();
        }
        return;
      }
      if ((k === 'Delete' || k === 'Backspace') && _selIdx >= 0 && !_anns[_selIdx]?.locked) {
        _pushUndoState();
        _anns.splice(_selIdx, 1); _selIdx = -1; _redraw(); _renderAnnList(); _updateShortcutHints();
      }
    });

    document.addEventListener('keyup', e => {
      if (e.key === 'Shift') {
        if (_shiftHeld) {
          _shiftHeld = false;
          const canvas = document.getElementById('ann2-canvas');
          if (canvas) {
            canvas.style.cursor = _tool === 'drag' ? 'grab' : 'crosshair';
          }
          _redraw();
        }
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
    if (c) c.style.cursor = t === 'grab' ? 'grab' : 'crosshair';

    const autoAnnLabel = document.getElementById('ann2-auto-annotate-label');
    const settingsBtn = document.getElementById('ann2-settings-btn');
    const iouBtn = document.getElementById('ann2-iou-toggle');
    const magicSettingsBtn = document.getElementById('ann2-magic-settings-btn');
    if (autoAnnLabel) autoAnnLabel.style.display = (t === 'autoann') ? 'flex' : 'none';
    if (settingsBtn) settingsBtn.style.display = (t === 'autoann') ? 'flex' : 'none';
    if (iouBtn) iouBtn.style.display = (t === 'autoann') ? 'flex' : 'none';
    if (magicSettingsBtn) magicSettingsBtn.style.display = (t === 'magic') ? 'flex' : 'none';

    if (t === 'autoann') {
      const chk = document.getElementById('ann2-auto-annotate-chk');
      if (chk) {
        _autoAnnotateActive = chk.checked;
      }
      ann2OpenAutoSettingsModal();
    } else {
      ann2CloseAutoSettingsModal();
    }

    if (t === 'magic') {
      ann2OpenMagicSettingsModal();
    } else {
      ann2CloseMagicSettingsModal();
    }
    _updateShortcutHints();
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

  // Hit test for temp auto anns (returns index or -1)
  function _hitTempAnn(ix, iy) {
    if (!_tempAutoAnns.length) return -1;
    for (let i = _tempAutoAnns.length - 1; i >= 0; i--) {
      const ann = _tempAutoAnns[i];
      if (_ptInPoly(ix, iy, ann.points)) return i;
    }
    return -1;
  }

  // Hit test for a vertex of a temp ann (returns vertex index or -1)
  // cx, cy are canvas coords
  function _hitTempVertex(cx, cy, ann) {
    if (!ann || ann.type === 'bbox') return -1;
    for (let i = 0; i < ann.points.length; i++) {
      const c = _i2c(ann.points[i][0], ann.points[i][1]);
      const dx = cx - c.x, dy = cy - c.y;
      if (dx * dx + dy * dy <= 64) return i;
    }
    return -1;
  }

  // ── Mouse Handlers ──
  function _onDown(e) {
    const rect = e.target.getBoundingClientRect();
    const cx = e.clientX - rect.left, cy = e.clientY - rect.top;
    const ip = _c2i(cx, cy);

    if (e.button === 1) { // Middle click drag pan in any tool
      e.preventDefault();
      _panning = true; _panStart = { mx: cx, my: cy, px: _pan.x, py: _pan.y };
      e.target.style.cursor = 'grabbing'; return;
    }
    if (e.button !== 0) return;

    // Autoann review mode: interact with temp annotations
    if (_tool === 'autoann' && _tempAutoAnns.length > 0 && !_autoProcessing) {
      // First check if clicking on a vertex of selected ann
      if (_tempAnnSelIdx >= 0 && _tempAutoAnns[_tempAnnSelIdx]) {
        const vi = _hitTempVertex(cx, cy, _tempAutoAnns[_tempAnnSelIdx]);
        if (vi >= 0) {
          // Start vertex drag
          _tempAnnDragVertex = vi;
          _tempAnnDragVertStart = { cx, cy, ix: ip.x, iy: ip.y };
          _tempAnnSelectedVertex = vi;
          _redraw();
          _updateShortcutHints();
          return;
        }
        // Click inside selected ann: start whole-annotation drag
        const ti2 = _hitTempAnn(ip.x, ip.y);
        if (ti2 === _tempAnnSelIdx) {
          _tempAnnDragVertex = -1;
          _tempAnnDragVertStart = { cx, cy, ix: ip.x, iy: ip.y, wholeAnn: true,
            origPts: _tempAutoAnns[_tempAnnSelIdx].points.map(p => [...p]) };
          return;
        }
      }
      // Hit test on temp anns
      const ti = _hitTempAnn(ip.x, ip.y);
      if (ti >= 0) {
        _tempAnnSelIdx = ti;
        _tempAnnHoverIdx = -1;
        _tempAnnSelectedVertex = -1;
        _updateShortcutHints();
        _redraw();
        return;
      } else {
        // Click on empty: deselect
        _tempAnnSelIdx = -1;
        _tempAnnSelectedVertex = -1;
        _updateShortcutHints();
        _redraw();
        return;
      }
    }

    if (_tool === 'drag') {
      _panning = true; _panStart = { mx: cx, my: cy, px: _pan.x, py: _pan.y };
      e.target.style.cursor = 'grabbing'; return;
    }

    if (_tool === 'magic') {
      // Shift+Click: enter replace-select mode — pick an existing annotation to replace
      if (e.shiftKey) {
        const hi = _hitTest(ip.x, ip.y);
        if (hi >= 0) {
          // Select the target annotation for replacement
          _magicReplaceIdx = hi;
          _selIdx = hi;
          // Sync class dropdown to the selected annotation's class
          const annCid = _anns[hi].class_id;
          const sel = document.getElementById('ann2-class-sel');
          if (sel) {
            sel.value = annCid;
            _updateClassDotColor();
          }
          // Clear any existing magic points to start fresh for replacement
          _magicPts = [];
          _magicPreview = null;
          _magicLoading = false;
          _redraw();
          _renderAnnList();
          _updateShortcutHints();
        } else {
          // Shift+Click on empty area: cancel replace mode
          _magicReplaceIdx = -1;
          _selIdx = -1;
          _redraw();
          _renderAnnList();
          _updateShortcutHints();
        }
        return;
      }

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
        if (ci >= 0) {
          _dragCorner = ci;
          _dragCornerOrig = _anns[_selIdx].points.map(p => [...p]);
          _beforeEditSnapshot = JSON.parse(JSON.stringify(_anns));
          return;
        }
      }
      const hi = _hitTest(ip.x, ip.y);
      if (hi >= 0) {
        _selIdx = hi;
        const sel = document.getElementById('ann2-class-sel');
        if (sel && _anns[hi]) {
          sel.value = _anns[hi].class_id;
          if (typeof _updateClassDotColor === 'function') _updateClassDotColor();
        }
        if (!_anns[hi].locked) {
          _dragAnn = true;
          _dragAnnStart = { x: ip.x, y: ip.y };
          _dragAnnOrig = _anns[hi].points.map(p => [...p]);
          _beforeEditSnapshot = JSON.parse(JSON.stringify(_anns));
        }
        _redraw(); _renderAnnList(); _updateShortcutHints(); return;
      } else {
        _selIdx = -1; _redraw(); _renderAnnList(); _updateShortcutHints(); return;
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

    // Autoann review mode: hover / vertex drag / whole-ann drag
    if (_tool === 'autoann' && _tempAutoAnns.length > 0 && !_autoProcessing) {
      if (_tempAnnDragVertStart) {
        const ann = _tempAutoAnns[_tempAnnSelIdx];
        if (ann) {
          if (_tempAnnDragVertStart.wholeAnn) {
            // Whole annotation drag
            const dx = ip.x - _tempAnnDragVertStart.ix;
            const dy = ip.y - _tempAnnDragVertStart.iy;
            ann.points = _tempAnnDragVertStart.origPts.map(p => [_clp(p[0] + dx), _clp(p[1] + dy)]);
          } else if (_tempAnnDragVertex >= 0) {
            // Single vertex drag
            ann.points[_tempAnnDragVertex] = [_clp(ip.x), _clp(ip.y)];
          }
          _redraw();
        }
        return;
      }
      // Hover detection
      if (_tempAnnSelIdx >= 0 && _tempAutoAnns[_tempAnnSelIdx]) {
        const vi = _hitTempVertex(cx, cy, _tempAutoAnns[_tempAnnSelIdx]);
        e.target.style.cursor = vi >= 0 ? 'pointer' : 'move';
      } else {
        const ti = _hitTempAnn(ip.x, ip.y);
        _tempAnnHoverIdx = ti;
        e.target.style.cursor = ti >= 0 ? 'pointer' : 'crosshair';
      }
      if (!_panning) { _redraw(); return; }
    }

    if (!_panning && _dragCorner === -1 && !_dragAnn && !_drawing) {
      _hoverIdx = _hitTest(ip.x, ip.y);
    }

    // In magic mode + Shift held: show hover highlight for replace-select
    if (_tool === 'magic' && (e.shiftKey || _shiftHeld) && _magicPts.length === 0 && !_magicLoading) {
      _hoverIdx = _hitTest(ip.x, ip.y);
      e.target.style.cursor = _hoverIdx >= 0 ? 'pointer' : 'crosshair';
      _redraw();
      return;
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
    // Temp ann drag vertex / whole-ann drag
    if (_tempAnnDragVertStart) {
      const rect = e.target.getBoundingClientRect();
      const cx = e.clientX - rect.left, cy = e.clientY - rect.top;
      const dxPx = cx - _tempAnnDragVertStart.cx, dyPx = cy - _tempAnnDragVertStart.cy;
      const moved = dxPx * dxPx + dyPx * dyPx > 16; // >4px = drag
      if (moved) {
        if (!_tempAnnDragVertStart.wholeAnn && _tempAnnDragVertex >= 0) {
          _tempAnnSelectedVertex = _tempAnnDragVertex;
        }
      } else {
        if (!_tempAnnDragVertStart.wholeAnn && _tempAnnDragVertex >= 0) {
          _tempAnnSelectedVertex = _tempAnnDragVertex;
        } else {
          _tempAnnSelectedVertex = -1;
        }
      }
      _tempAnnDragVertex = -1;
      _tempAnnDragVertStart = null;
      _redraw();
      _updateShortcutHints();
      return;
    }
    if (_panning) { _panning = false; e.target.style.cursor = 'grab'; return; }
    if (_dragCorner >= 0) {
      if (_beforeEditSnapshot) {
        const changed = JSON.stringify(_anns) !== JSON.stringify(_beforeEditSnapshot);
        if (changed) {
          _undoStack.push(_beforeEditSnapshot);
          _redoStack = [];
        }
        _beforeEditSnapshot = null;
      }
      _dragCorner = -1; _dragCornerOrig = null;
      _updateShortcutHints();
      return;
    }
    if (_dragAnn) {
      if (_beforeEditSnapshot) {
        const changed = JSON.stringify(_anns) !== JSON.stringify(_beforeEditSnapshot);
        if (changed) {
          _undoStack.push(_beforeEditSnapshot);
          _redoStack = [];
        }
        _beforeEditSnapshot = null;
      }
      _dragAnn = false; _dragAnnStart = null; _dragAnnOrig = null;
      _updateShortcutHints();
      return;
    }
    if (_drawing && _tool === 'bbox' && _drawStart && _mouseImg) {
      const x1 = Math.min(_drawStart.x, _clp(_mouseImg.x)), y1 = Math.min(_drawStart.y, _clp(_mouseImg.y));
      const x2 = Math.max(_drawStart.x, _clp(_mouseImg.x)), y2 = Math.max(_drawStart.y, _clp(_mouseImg.y));
      if ((x2 - x1) > MIN_BBOX && (y2 - y1) > MIN_BBOX) {
        const cid = parseInt(document.getElementById('ann2-class-sel')?.value);
        if (!isNaN(cid) && _ds?.classes?.names[cid]) {
          _pushUndoState();
          _anns.push({ class_id: cid, points: [[x1, y1], [x2, y2]], type: 'bbox', locked: false });
          _selIdx = _anns.length - 1; _renderAnnList();
        }
      }
      _drawing = false; _drawStart = null; _redraw(); _updateShortcutHints();
    }
  }

  function _onLeave(e) {
    if (_panning) { _panning = false; e.target.style.cursor = _tool === 'drag' ? 'grab' : 'crosshair'; }
    _mouseImg = null; _hoverIdx = -1; _tempAnnHoverIdx = -1;
    if (_drawing || _tool === 'edit' || _tool === 'magic' || (_tool === 'autoann' && _tempAutoAnns.length > 0)) _redraw();
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
      _pushUndoState();
      _anns.push({ class_id: cid, points: _polyPts.map(p => [...p]), type: 'polygon', locked: false });
      _selIdx = _anns.length - 1; _renderAnnList();
    }
    _cancelPoly();
  }
  function _cancelPoly() {
    _drawing = false; _polyPts = [];
    _updateShortcutHints();
    _redraw();
  }

  // ── Magic Selection ──
  function _cancelMagic() {
    _magicPts = [];
    _magicPreview = null;
    _magicLoading = false;
    _magicReplaceIdx = -1;
    _updateShortcutHints();
    _redraw();
  }

  function _confirmMagic() {
    if (!_magicPreview || _magicPreview.length < 3) return;
    const cid = parseInt(document.getElementById('ann2-class-sel')?.value);
    if (isNaN(cid) || !_ds?.classes?.names[cid]) {
      if (window.toast) toast('Pilih class terlebih dahulu', 'err');
      return;
    }
    _pushUndoState();
    const newAnn = { class_id: cid, points: _magicPreview.map(p => [p[0], p[1]]), type: 'polygon', locked: false };
    if (_magicReplaceIdx >= 0 && _magicReplaceIdx < _anns.length) {
      // Replace existing annotation
      _anns[_magicReplaceIdx] = newAnn;
      _selIdx = _magicReplaceIdx;
      if (window.toast) toast(`Anotasi #${_magicReplaceIdx + 1} diganti ✓`);
    } else {
      // Add new annotation
      _anns.push(newAnn);
      _selIdx = _anns.length - 1;
    }
    _magicReplaceIdx = -1;
    _renderAnnList();
    _magicPts = [];
    _magicPreview = null;
    _magicLoading = false;
    _updateShortcutHints();
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
        body: JSON.stringify({
          filename: imgObj.filename,
          points: _magicPts,
          model: _autoAnnotateSettings.magic_model || 'sam3',
          device: _autoAnnotateSettings.magic_device || 'cuda:0',
          imgsz: _autoAnnotateSettings.magic_imgsz !== undefined ? _autoAnnotateSettings.magic_imgsz : 1024
        })
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

    // Dimming overlay for Edit Mode or Magic Selection with Shift / Replace active
    if (_tool === 'edit' || (_tool === 'magic' && (_shiftHeld || _magicReplaceIdx >= 0))) {
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

    // Draw temporary auto-annotate preview polygons (Unchecked mode)
    if (_tempAutoAnns && _tempAutoAnns.length > 0) {
      _tempAutoAnns.forEach((ann, tidx) => {
        const col = _clsColor(ann.class_id);
        const isSel = tidx === _tempAnnSelIdx;
        const isHover = tidx === _tempAnnHoverIdx && !isSel;
        ctx.save();
        if (isSel) {
          ctx.strokeStyle = '#f59e0b'; // amber for selected
          ctx.lineWidth = 2.5;
          ctx.setLineDash([]);
        } else if (isHover) {
          ctx.strokeStyle = '#fff';
          ctx.lineWidth = 2;
          ctx.setLineDash([5, 4]);
        } else {
          ctx.strokeStyle = col;
          ctx.lineWidth = 2;
          ctx.setLineDash([5, 4]);
        }
        ctx.beginPath();
        ann.points.forEach((p, pi) => {
          const c = _i2c(p[0], p[1]);
          pi === 0 ? ctx.moveTo(c.x, c.y) : ctx.lineTo(c.x, c.y);
        });
        ctx.closePath();
        ctx.stroke();
        ctx.fillStyle = isSel ? 'rgba(245,158,11,0.18)' : (col + '1a');
        ctx.fill();
        ctx.restore();

        // Draw vertex dots for selected annotation
        if (isSel && ann.type === 'polygon') {
          ann.points.forEach((p, vi) => {
            const c = _i2c(p[0], p[1]);
            ctx.save();
            ctx.beginPath();
            if (vi === _tempAnnSelectedVertex) {
              ctx.rect(c.x - 5, c.y - 5, 10, 10);
            } else {
              ctx.arc(c.x, c.y, 5, 0, Math.PI * 2);
            }
            ctx.fillStyle = '#f59e0b';
            ctx.fill();
            ctx.strokeStyle = '#fff';
            ctx.lineWidth = 1.5;
            ctx.setLineDash([]);
            ctx.stroke();
            ctx.restore();
          });
        }
      });
    }

    // Draw IoU-rejected annotations as translucent red outlines
    if (_showIouRejected && _iouRejectedAnns && _iouRejectedAnns.length > 0) {
      _iouRejectedAnns.forEach(ann => {
        ctx.save();
        ctx.strokeStyle = 'rgba(239,68,68,0.7)';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ann.points.forEach((p, pi) => {
          const c = _i2c(p[0], p[1]);
          pi === 0 ? ctx.moveTo(c.x, c.y) : ctx.lineTo(c.x, c.y);
        });
        ctx.closePath();
        ctx.stroke();
        ctx.fillStyle = 'rgba(239,68,68,0.07)';
        ctx.fill();
        ctx.restore();
      });
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

    // Draw replace-target annotation highlight (amber dashed border)
    if (_magicReplaceIdx >= 0 && _magicReplaceIdx < _anns.length) {
      const target = _anns[_magicReplaceIdx];
      ctx.save();
      ctx.strokeStyle = '#fb923c';
      ctx.lineWidth = 2.5;
      ctx.setLineDash([8, 4]);
      ctx.shadowColor = '#fb923c';
      ctx.shadowBlur = 8;
      ctx.beginPath();
      if (target.type === 'bbox') {
        const [[x1, y1], [x2, y2]] = target.points;
        const c1 = _i2c(Math.min(x1,x2), Math.min(y1,y2));
        const c2 = _i2c(Math.max(x1,x2), Math.max(y1,y2));
        ctx.rect(c1.x, c1.y, c2.x - c1.x, c2.y - c1.y);
      } else {
        target.points.forEach((p, pi) => {
          const c = _i2c(p[0], p[1]);
          pi === 0 ? ctx.moveTo(c.x, c.y) : ctx.lineTo(c.x, c.y);
        });
        ctx.closePath();
      }
      ctx.stroke();
      ctx.fillStyle = 'rgba(251,146,60,0.15)';
      ctx.fill();
      ctx.restore();

      // Label: "→ replacing #N"
      if (target.points.length > 0) {
        const firstPt = target.type === 'bbox' ? _i2c(target.points[0][0], target.points[0][1]) : _i2c(target.points[0][0], target.points[0][1]);
        ctx.save();
        ctx.font = 'bold 11px Outfit, sans-serif';
        ctx.fillStyle = '#fb923c';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'bottom';
        ctx.fillText(`→ replace #${_magicReplaceIdx + 1}`, firstPt.x + 6, firstPt.y - 4);
        ctx.restore();
      }
    }

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
          _pushUndoState();
          const [moved] = _anns.splice(fromIdx, 1);
          _anns.splice(toIdx, 0, moved);
          _selIdx = toIdx;
          _redraw();
          _updateShortcutHints();
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
        _updateShortcutHints();
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
        _pushUndoState();
        _anns.splice(idx, 1); if (_selIdx >= idx) _selIdx = Math.max(-1, _selIdx - 1);
        _redraw(); _renderAnnList(); _updateShortcutHints();
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
      btn.textContent = '×'; btn.onclick = () => {
        _curTags = _curTags.filter(x => x !== tag);
        _renderTagsArea();
        window.ann2SaveTags();
      };
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
      window.ann2SaveTags();
    }
    sel.value = '';
  };

  window.ann2SaveTags = async function () {
    if (!_ds || !_images.length) return;
    const imgObj = _images[_idx];
    try {
      const resp = await fetch(`/api/dataset/${encodeURIComponent(_ds.name)}/image-tags`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filenames: [imgObj.filename], tags: _curTags })
      });
      if (resp.ok) {
        _originalTags = [..._curTags];
        if (window.toast) toast('Tags saved ✓');
      } else {
        if (window.toast) toast('Failed to save tags', 'err');
      }
    } catch (e) {
      console.error('Failed to save tags', e);
      if (window.toast) toast('Failed to save tags', 'err');
    }
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

  // ── Auto Annotate ──

  // ── Settings dirty-tracking helpers ──
  window.ann2MarkSettingsDirty = function () {
    _settingsDirty = true;
    const btn = document.getElementById('ann2-save-settings-btn');
    if (btn) { btn.disabled = false; }
  };

  function _markSettingsClean() {
    _settingsDirty = false;
    const btn = document.getElementById('ann2-save-settings-btn');
    if (btn) { btn.disabled = true; }
  }

  // ── Draggable floating panel ──
  window.ann2StartSettingsDrag = function (e) {
    // Ignore if click was on the close button
    if (e.target.tagName === 'BUTTON' || e.target.closest('button')) return;
    const panel = document.getElementById('ann2-auto-settings-modal');
    if (!panel) return;
    e.preventDefault();
    panel.classList.add('is-dragging');
    const startX = e.clientX - panel.offsetLeft;
    const startY = e.clientY - panel.offsetTop;
    // Once we start dragging, switch from right/top anchoring to left/top
    panel.style.right = 'auto';
    panel.style.left = panel.offsetLeft + 'px';
    panel.style.top  = panel.offsetTop  + 'px';
    function onMove(ev) {
      let nx = ev.clientX - startX;
      let ny = ev.clientY - startY;
      // Keep within viewport
      nx = Math.max(0, Math.min(nx, window.innerWidth  - panel.offsetWidth));
      ny = Math.max(0, Math.min(ny, window.innerHeight - panel.offsetHeight));
      panel.style.left = nx + 'px';
      panel.style.top  = ny + 'px';
    }
    function onUp() {
      panel.classList.remove('is-dragging');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup',   onUp);
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup',   onUp);
  };

  // Panel controls
  window.ann2OpenAutoSettingsModal = function () {
    const panel = document.getElementById('ann2-auto-settings-modal');
    if (!panel) return;
    panel.style.display = 'flex';
    // Snapshot current saved settings for cancel-revert
    _settingsSnapshot = JSON.parse(JSON.stringify(_autoAnnotateSettings));
    _loadAutoSettings();
  };

  window.ann2CloseAutoSettingsModal = function () {
    const panel = document.getElementById('ann2-auto-settings-modal');
    if (panel) panel.style.display = 'none';
  };

  window.ann2OpenMagicSettingsModal = function () {
    const panel = document.getElementById('ann2-magic-settings-modal');
    if (!panel) return;
    panel.style.display = 'flex';
    _magicSettingsSnapshot = JSON.parse(JSON.stringify(_autoAnnotateSettings));
    _loadAutoSettings();
  };

  window.ann2CloseMagicSettingsModal = function () {
    const panel = document.getElementById('ann2-magic-settings-modal');
    if (panel) panel.style.display = 'none';
  };

  window.ann2StartMagicSettingsDrag = function (e) {
    if (e.target.tagName === 'BUTTON' || e.target.closest('button')) return;
    const panel = document.getElementById('ann2-magic-settings-modal');
    if (!panel) return;
    e.preventDefault();
    panel.classList.add('is-dragging');
    const startX = e.clientX - panel.offsetLeft;
    const startY = e.clientY - panel.offsetTop;
    panel.style.right = 'auto';
    panel.style.left = panel.offsetLeft + 'px';
    panel.style.top  = panel.offsetTop  + 'px';
    function onMove(ev) {
      let nx = ev.clientX - startX;
      let ny = ev.clientY - startY;
      nx = Math.max(0, Math.min(nx, window.innerWidth  - panel.offsetWidth));
      ny = Math.max(0, Math.min(ny, window.innerHeight - panel.offsetHeight));
      panel.style.left = nx + 'px';
      panel.style.top  = ny + 'px';
    }
    function onUp() {
      panel.classList.remove('is-dragging');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup',   onUp);
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup',   onUp);
  };

  window.ann2MarkMagicSettingsDirty = function () {
    _magicSettingsDirty = true;
    const btn = document.getElementById('ann2-save-magic-settings-btn');
    if (btn) { btn.disabled = false; }
  };

  function _markMagicSettingsClean() {
    _magicSettingsDirty = false;
    const btn = document.getElementById('ann2-save-magic-settings-btn');
    if (btn) { btn.disabled = true; }
  }

  window.ann2SaveMagicSettings = async function () {
    if (!_ds) return;
    const magic_model = document.getElementById('ann2-magic-model')?.value || 'sam3';
    const magic_device = document.getElementById('ann2-magic-device')?.value || 'cuda:0';
    const magic_imgsz = parseInt(document.getElementById('ann2-magic-imgsz')?.value) || 1024;

    _autoAnnotateSettings.magic_model = magic_model;
    _autoAnnotateSettings.magic_device = magic_device;
    _autoAnnotateSettings.magic_imgsz = magic_imgsz;

    try {
      await fetch(`/api/dataset/${encodeURIComponent(_ds.name)}/auto-annotate-settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(_autoAnnotateSettings)
      });
      _magicSettingsSnapshot = JSON.parse(JSON.stringify(_autoAnnotateSettings));
      _markMagicSettingsClean();
      if (window.toast) toast('Settings Magic disimpan ✓');
    } catch (e) {
      if (window.toast) toast('Gagal menyimpan settings magic', 'err');
    }
  };

  window.ann2CancelMagicSettings = function () {
    if (_magicSettingsSnapshot) {
      _autoAnnotateSettings = JSON.parse(JSON.stringify(_magicSettingsSnapshot));
      _renderMagicSettingsPanel();
    }
    _markMagicSettingsClean();
  };

  function _renderMagicSettingsPanel() {
    const modelSel = document.getElementById('ann2-magic-model');
    if (modelSel) modelSel.value = _autoAnnotateSettings.magic_model || 'sam3';
    const deviceSel = document.getElementById('ann2-magic-device');
    if (deviceSel) deviceSel.value = _autoAnnotateSettings.magic_device || 'cuda:0';
    const imgszInput = document.getElementById('ann2-magic-imgsz');
    if (imgszInput) imgszInput.value = _autoAnnotateSettings.magic_imgsz !== undefined ? _autoAnnotateSettings.magic_imgsz : 1024;
  }

  // Toggle auto annotate mode
  window.ann2ToggleAutoAnnotate = function (checked) {
    _autoAnnotateActive = checked;
    if (checked) {
      if (_tool !== 'autoann') {
        _setTool('autoann');
      } else {
        _updateShortcutHints();
      }
      ann2OpenAutoSettingsModal();
    } else {
      _updateShortcutHints();
    }
  };

  function _updateShortcutHints() {
    const hints = document.getElementById('ann2-shortcut-hints');
    if (!hints) return;

    let html = '';

    // Tool-specific hints
    if (_tool === 'drag') {
      html += `
        <div class="ann2-shortcut-badge"><kbd>Scroll</kbd> Zoom</div>
        <div class="ann2-shortcut-badge"><kbd>H</kbd> / <kbd>Middle Drag</kbd> Pan</div>
      `;
    } else if (_tool === 'bbox') {
      html += `
        <div class="ann2-shortcut-badge"><kbd>Drag Mouse</kbd> Draw BBox</div>
      `;
    } else if (_tool === 'polygon') {
      if (_drawing) {
        html += `
          <div class="ann2-shortcut-badge"><kbd>Left Click</kbd> Add Point</div>
          <div class="ann2-shortcut-badge"><kbd>Enter</kbd> / <kbd>DblClick</kbd> Confirm</div>
          <div class="ann2-shortcut-badge"><kbd>Esc</kbd> / <kbd>Right Click</kbd> Cancel</div>
        `;
      } else {
        html += `
          <div class="ann2-shortcut-badge"><kbd>Left Click</kbd> Start Polygon</div>
        `;
      }
    } else if (_tool === 'edit') {
      html += `
        <div class="ann2-shortcut-badge"><kbd>Left Click</kbd> Select</div>
        <div class="ann2-shortcut-badge"><kbd>Drag</kbd> Edit Vertex/Ann</div>
      `;
      if (_selIdx >= 0 && !_anns[_selIdx]?.locked) {
        html += `<div class="ann2-shortcut-badge"><kbd>Del</kbd> / <kbd>Backspace</kbd> Delete Ann</div>`;
      }
    } else if (_tool === 'magic') {
      html += `
        <div class="ann2-shortcut-badge"><kbd>Left Click</kbd> Positive Point</div>
        <div class="ann2-shortcut-badge"><kbd>Ctrl+Click</kbd> Negative Point</div>
        <div class="ann2-shortcut-badge"><kbd>Shift+Click</kbd> Replace Ann</div>
      `;
      if (_magicPreview && _magicPreview.length >= 3) {
        html += `
          <div class="ann2-shortcut-badge"><kbd>Enter</kbd> Confirm</div>
          <div class="ann2-shortcut-badge"><kbd>Esc</kbd> Cancel</div>
        `;
      }
    } else if (_tool === 'autoann') {
      if (_autoAnnotateActive) {
        html += `
          <div class="ann2-shortcut-badge"><kbd>S</kbd> Process &amp; Next (Loop)</div>
        `;
      } else {
        if (_tempAutoAnns && _tempAutoAnns.length > 0) {
          html += `
            <div class="ann2-shortcut-badge"><kbd>Enter</kbd> Confirm Scan</div>
            <div class="ann2-shortcut-badge"><kbd>Esc</kbd> Cancel Scan</div>
          `;
          if (_tempAnnSelIdx >= 0) {
            if (_tempAnnSelectedVertex >= 0) {
              html += `<div class="ann2-shortcut-badge"><kbd>Del</kbd> Delete Vertex</div>`;
            } else {
              html += `<div class="ann2-shortcut-badge"><kbd>Del</kbd> Delete Ann</div>`;
            }
          }
        } else {
          html += `
            <div class="ann2-shortcut-badge"><kbd>S</kbd> Scan Image</div>
          `;
        }
      }
    }

    // Global navigation and actions
    const undoCount = _undoStack.length;
    const redoCount = _redoStack.length;
    html += `
      <div style="width:100%;height:1px;background:var(--border);margin:4px 0;"></div>
      <div class="ann2-shortcut-badge"><kbd>A</kbd> / <kbd>←</kbd> Prev Image</div>
      <div class="ann2-shortcut-badge"><kbd>D</kbd> / <kbd>→</kbd> Next Image</div>
      <div class="ann2-shortcut-badge"><kbd>Ctrl+S</kbd> Save</div>
      <div class="ann2-shortcut-badge" style="opacity:${undoCount > 0 ? 1 : 0.4};"><kbd>Ctrl+Z</kbd> Undo${undoCount > 0 ? ` (${undoCount})` : ''}</div>
      <div class="ann2-shortcut-badge" style="opacity:${redoCount > 0 ? 1 : 0.4};"><kbd>Ctrl+Y</kbd> Redo${redoCount > 0 ? ` (${redoCount})` : ''}</div>
    `;

    hints.innerHTML = html;
    hints.style.display = 'flex';
    _checkSimplifyPanelVisibility();
  }

  function _pushUndoState() {
    _undoStack.push(JSON.parse(JSON.stringify(_anns)));
    _redoStack = [];
    _updateShortcutHints();
  }

  function _undo() {
    if (_undoStack.length === 0) return;
    const currentState = JSON.parse(JSON.stringify(_anns));
    _redoStack.push(currentState);
    _anns = _undoStack.pop();
    _selIdx = -1;
    _redraw();
    _renderAnnList();
    _updateShortcutHints();
    if (_autosave) ann2Save();
  }

  function _redo() {
    if (_redoStack.length === 0) return;
    const currentState = JSON.parse(JSON.stringify(_anns));
    _undoStack.push(currentState);
    _anns = _redoStack.pop();
    _selIdx = -1;
    _redraw();
    _renderAnnList();
    _updateShortcutHints();
    if (_autosave) ann2Save();
  }

  async function _loadAutoSettings() {
    if (!_ds) return;
    try {
      const r = await fetch(`/api/dataset/${encodeURIComponent(_ds.name)}/auto-annotate-settings`);
      if (r.ok) {
        const s = await r.json();
        _autoAnnotateSettings = s;
        _autoApprovedTags = [...(s.on_approved_tags || [])];
      }
    } catch (e) { console.error('Failed to load auto-annotate settings', e); }

    // Fetch GPU list and populate device selects
    try {
      const gr = await fetch('/api/gpu/list');
      if (gr.ok) {
        const gd = await gr.json();
        _gpuList = gd.gpus || [];
        ['ann2-auto-device', 'ann2-recheck-device', 'ann2-magic-device'].forEach(id => {
          const sel = document.getElementById(id);
          if (!sel) return;
          sel.innerHTML = _gpuList.map(g => `<option value="${g.id}">${g.name}</option>`).join('');
        });
      }
    } catch (e) { console.warn('Could not fetch GPU list', e); }

    _renderAutoSettingsPanel();
    _renderMagicSettingsPanel();
    // Freshly loaded from server = clean state
    _settingsSnapshot = JSON.parse(JSON.stringify(_autoAnnotateSettings));
    _magicSettingsSnapshot = JSON.parse(JSON.stringify(_autoAnnotateSettings));
    _markSettingsClean();
    _markMagicSettingsClean();
  }

  function _renderAutoSettingsPanel() {
    // Conf & IoU sliders
    const confSlider = document.getElementById('ann2-conf-slider');
    const confVal = document.getElementById('ann2-conf-val');
    const iouSlider = document.getElementById('ann2-iou-slider');
    const iouVal = document.getElementById('ann2-iou-val');
    const confPct = Math.round((_autoAnnotateSettings.conf || 0.25) * 100);
    const iouPct = Math.round((_autoAnnotateSettings.iou || 0.85) * 100);
    if (confSlider) { confSlider.value = confPct; if (confVal) confVal.textContent = confPct + '%'; }
    if (iouSlider)  { iouSlider.value  = iouPct;  if (iouVal)  iouVal.textContent  = iouPct  + '%'; }

    // Model
    const modelSel = document.getElementById('ann2-auto-model');
    if (modelSel) modelSel.value = _autoAnnotateSettings.model || 'sam3.1';

    // Main GPU device
    const deviceSel = document.getElementById('ann2-auto-device');
    if (deviceSel) deviceSel.value = _autoAnnotateSettings.device || 'cuda:0';

    // Recheck
    const recheckChk = document.getElementById('ann2-auto-recheck');
    if (recheckChk) {
      recheckChk.checked = !!_autoAnnotateSettings.recheck;
      ann2ToggleRecheck(recheckChk.checked);
    }
    const recheckModelSel = document.getElementById('ann2-auto-recheck-model');
    if (recheckModelSel) recheckModelSel.value = _autoAnnotateSettings.recheck_model || 'sam3';
    const recheckDeviceSel = document.getElementById('ann2-recheck-device');
    if (recheckDeviceSel) recheckDeviceSel.value = _autoAnnotateSettings.recheck_device || 'cuda:0';

    // Recheck Threshold Sliders & Image Size
    const recheckMinSlider = document.getElementById('ann2-recheck-min-slider');
    const recheckMinVal = document.getElementById('ann2-recheck-min-val');
    const recheckMaxSlider = document.getElementById('ann2-recheck-max-slider');
    const recheckMaxVal = document.getElementById('ann2-recheck-max-val');
    const recheckImgszInput = document.getElementById('ann2-recheck-imgsz');
    const minPct = Math.round((_autoAnnotateSettings.recheck_min_area !== undefined ? _autoAnnotateSettings.recheck_min_area : 0.70) * 100);
    const maxPct = Math.round((_autoAnnotateSettings.recheck_max_area !== undefined ? _autoAnnotateSettings.recheck_max_area : 1.20) * 100);
    if (recheckMinSlider) { recheckMinSlider.value = minPct; if (recheckMinVal) recheckMinVal.textContent = minPct + '%'; }
    if (recheckMaxSlider) { recheckMaxSlider.value = maxPct; if (recheckMaxVal) recheckMaxVal.textContent = maxPct + '%'; }
    if (recheckImgszInput) { recheckImgszInput.value = _autoAnnotateSettings.recheck_imgsz !== undefined ? _autoAnnotateSettings.recheck_imgsz : 1024; }

    // Prompts
    const container = document.getElementById('ann2-auto-prompts');
    if (container) {
      container.innerHTML = '';
      const prompts = _autoAnnotateSettings.prompts || [];
      prompts.forEach((p, idx) => _addPromptRowDOM(container, p.prompt, p.class_id, idx));
      if (prompts.length === 0) _addPromptRowDOM(container, '', 0, 0);
    }

    // Tags
    _renderAutoTagsArea();

    // YOLO entries
    _renderYoloEntries();

    // Apply None-mode disabled states
    requestAnimationFrame(() => ann2OnModelChange());
  }

  function _populateClassOptions(clsSel, selectedClassId) {
    clsSel.innerHTML = '';
    const names = _ds?.classes?.names || [];
    names.forEach((n, i) => {
      const opt = document.createElement('option');
      opt.value = i;
      opt.textContent = `${i}: ${n}`;
      if (i === selectedClassId) opt.selected = true;
      clsSel.appendChild(opt);
    });

    const addOpt = document.createElement('option');
    addOpt.value = '__add_new__';
    addOpt.textContent = '+ Tambah Class Baru...';
    addOpt.style.fontWeight = 'bold';
    addOpt.style.color = '#a855f7';
    clsSel.appendChild(addOpt);
  }

  async function _addNewClassPrompt(clsSel) {
    const name = prompt('Masukkan nama class baru:');
    if (!name || !name.trim()) {
      clsSel.value = 0;
      return;
    }
    const newClassName = name.trim();
    if (!_ds.classes) _ds.classes = { names: [] };
    if (!_ds.classes.names) _ds.classes.names = [];

    const newId = _ds.classes.names.length;
    _ds.classes.names.push(newClassName);

    try {
      await fetch(`/api/dataset/${encodeURIComponent(_ds.name)}/class-settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ names: _ds.classes.names })
      });
    } catch (e) {
      console.warn('Could not persist class setting to server:', e);
    }

    _buildClassSel();

    document.querySelectorAll('#ann2-auto-prompts select').forEach(s => {
      const curVal = s === clsSel ? newId : parseInt(s.value);
      _populateClassOptions(s, curVal);
    });

    if (window.toast) toast(`Class '${newClassName}' ditambahkan ✓`);
  }

  function _addPromptRowDOM(container, promptText, classId, idx) {
    const row = document.createElement('div');
    row.className = 'ann2-prompt-row';
    row.dataset.idx = idx;

    const input = document.createElement('input');
    input.type = 'text';
    input.value = promptText || '';
    input.placeholder = 'e.g. car, license plate...';
    input.oninput = () => window.ann2MarkSettingsDirty && ann2MarkSettingsDirty();

    const clsSel = document.createElement('select');
    _populateClassOptions(clsSel, classId);

    clsSel.onchange = function () {
      if (this.value === '__add_new__') {
        _addNewClassPrompt(clsSel);
      } else {
        ann2MarkSettingsDirty();
      }
    };

    const delBtn = document.createElement('button');
    delBtn.className = 'ann2-prompt-del';
    delBtn.textContent = '×';
    delBtn.title = 'Remove';
    delBtn.onclick = () => { row.remove(); ann2MarkSettingsDirty(); };

    row.append(input, clsSel, delBtn);
    container.appendChild(row);
  }

  window.ann2AddPromptRow = function () {
    const container = document.getElementById('ann2-auto-prompts');
    if (!container) return;
    const idx = container.children.length;
    _addPromptRowDOM(container, '', 0, idx);
    ann2MarkSettingsDirty();
  };

  function _renderAutoTagsArea() {
    const area = document.getElementById('ann2-auto-tags-area');
    if (!area) return;
    area.innerHTML = '';
    _autoApprovedTags.forEach(tag => {
      const chip = document.createElement('span');
      chip.className = 'ann2-auto-tag-chip';
      chip.textContent = tag;
      const btn = document.createElement('button');
      btn.textContent = '×';
      btn.onclick = () => {
        _autoApprovedTags = _autoApprovedTags.filter(t => t !== tag);
        _renderAutoTagsArea();
        ann2MarkSettingsDirty();
      };
      chip.appendChild(btn);
      area.appendChild(chip);
    });

    // Populate tag select
    const sel = document.getElementById('ann2-auto-tag-sel');
    if (sel) {
      sel.innerHTML = '<option value="">+ Tambah tag...</option>';
      _tags.forEach(t => {
        if (!_autoApprovedTags.includes(t.name)) {
          const opt = document.createElement('option');
          opt.value = t.name; opt.textContent = t.name;
          sel.appendChild(opt);
        }
      });
    }
  }

  window.ann2AddAutoTag = function (sel) {
    const val = sel.value;
    if (val && !_autoApprovedTags.includes(val)) {
      _autoApprovedTags.push(val);
      _renderAutoTagsArea();
      ann2MarkSettingsDirty();
    }
    sel.value = '';
  };

  window.ann2ToggleRecheck = function (checked) {
    const group = document.getElementById('ann2-auto-recheck-model-group');
    if (group) group.style.display = checked ? 'flex' : 'none';
  };

  window.ann2SaveAutoSettings = async function () {
    if (!_ds) return;
    // Collect prompts from DOM
    const rows = document.querySelectorAll('#ann2-auto-prompts .ann2-prompt-row');
    const prompts = [];
    rows.forEach(row => {
      const input = row.querySelector('input');
      const sel = row.querySelector('select');
      const prompt = input?.value?.trim();
      const class_id = parseInt(sel?.value) || 0;
      if (prompt) prompts.push({ prompt, class_id });
    });

    const model = document.getElementById('ann2-auto-model')?.value || 'sam3.1';
    const conf = parseFloat(document.getElementById('ann2-conf-slider')?.value || 25) / 100;
    const iou  = parseFloat(document.getElementById('ann2-iou-slider')?.value  || 85) / 100;
    const device = document.getElementById('ann2-auto-device')?.value || 'cuda:0';
    const recheck = !!document.getElementById('ann2-auto-recheck')?.checked;
    const recheck_model = document.getElementById('ann2-auto-recheck-model')?.value || 'sam3';
    const recheck_device = document.getElementById('ann2-recheck-device')?.value || 'cuda:0';
    const recheck_min_area = parseFloat(document.getElementById('ann2-recheck-min-slider')?.value || 70) / 100;
    const recheck_max_area = parseFloat(document.getElementById('ann2-recheck-max-slider')?.value || 120) / 100;
    const recheck_imgsz = parseInt(document.getElementById('ann2-recheck-imgsz')?.value) || 1024;
    const yolo_entries = _collectYoloEntries();

    _autoAnnotateSettings = { model, prompts, on_approved_tags: [..._autoApprovedTags], conf, iou, device, recheck, recheck_model, recheck_device, recheck_min_area, recheck_max_area, recheck_imgsz, yolo_entries };

    try {
      await fetch(`/api/dataset/${encodeURIComponent(_ds.name)}/auto-annotate-settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(_autoAnnotateSettings)
      });
      // Update snapshot to match newly-saved state
      _settingsSnapshot = JSON.parse(JSON.stringify(_autoAnnotateSettings));
      _markSettingsClean();
      if (window.toast) toast('Settings disimpan ✓');
      // Panel stays visible — no close
    } catch (e) {
      if (window.toast) toast('Gagal menyimpan settings', 'err');
    }
  };

  window.ann2CancelAutoSettings = function () {
    // Revert DOM to snapshotted state
    if (_settingsSnapshot) {
      _autoAnnotateSettings = JSON.parse(JSON.stringify(_settingsSnapshot));
      _autoApprovedTags = [...(_settingsSnapshot.on_approved_tags || [])];
      _renderAutoSettingsPanel();
    }
    _markSettingsClean();
  };

  // ── None model: disable/enable sections ──
  window.ann2OnModelChange = function () {
    const modelVal = document.getElementById('ann2-auto-model')?.value;
    const isNone = modelVal === 'none';
    const recheckSec = document.getElementById('ann2-recheck-section');
    const promptsSec = document.getElementById('ann2-prompts-section');
    if (recheckSec) {
      if (isNone) {
        recheckSec.classList.add('ann2-section-disabled');
        // Uncheck recheck
        const chk = document.getElementById('ann2-auto-recheck');
        if (chk) { chk.checked = false; ann2ToggleRecheck(false); }
      } else {
        recheckSec.classList.remove('ann2-section-disabled');
      }
    }
    if (promptsSec) {
      if (isNone) {
        promptsSec.classList.add('ann2-section-disabled');
      } else {
        promptsSec.classList.remove('ann2-section-disabled');
      }
    }
  };

  // ── YOLO model dropdown toggle ──
  window.ann2ToggleYoloModelDropdown = function (e) {
    e.stopPropagation();
    const dd = document.getElementById('ann2-yolo-model-dropdown');
    if (!dd) return;
    const isOpen = dd.style.display !== 'none';
    dd.style.display = isOpen ? 'none' : 'flex';
  };

  // Close YOLO dropdown on outside click
  document.addEventListener('click', function (e) {
    const dd = document.getElementById('ann2-yolo-model-dropdown');
    const btn = document.getElementById('ann2-add-yolo-btn');
    if (dd && btn && !btn.contains(e.target) && !dd.contains(e.target)) {
      dd.style.display = 'none';
    }
  });

  // Available YOLO models and their class names
  const YOLO_MODELS = {
    'yolo26x-seg': {
      label: 'YOLO26x Segment',
      // COCO 80 class names (placeholder — fetched from server if available)
      classes: null // will be fetched/cached
    }
  };

  // Fetch YOLO model names from server (or use COCO defaults)
  async function _fetchYoloNames(modelKey) {
    if (_yoloClassCache[modelKey]) return _yoloClassCache[modelKey];
    try {
      const r = await fetch(`/api/yolo-model-names?model=${encodeURIComponent(modelKey)}`);
      if (r.ok) {
        const d = await r.json();
        if (d.names && d.names.length > 0) {
          _yoloClassCache[modelKey] = d.names;
          return d.names;
        }
      }
    } catch (e) { /* ignore */ }
    // Fallback: COCO 80 names
    const coco = [
      'person','bicycle','car','motorcycle','airplane','bus','train','truck','boat',
      'traffic light','fire hydrant','stop sign','parking meter','bench','bird','cat',
      'dog','horse','sheep','cow','elephant','bear','zebra','giraffe','backpack',
      'umbrella','handbag','tie','suitcase','frisbee','skis','snowboard','sports ball',
      'kite','baseball bat','baseball glove','skateboard','surfboard','tennis racket',
      'bottle','wine glass','cup','fork','knife','spoon','bowl','banana','apple',
      'sandwich','orange','broccoli','carrot','hot dog','pizza','donut','cake','chair',
      'couch','potted plant','bed','dining table','toilet','tv','laptop','mouse',
      'remote','keyboard','cell phone','microwave','oven','toaster','sink',
      'refrigerator','book','clock','vase','scissors','teddy bear','hair drier',
      'toothbrush'
    ];
    _yoloClassCache[modelKey] = coco;
    return coco;
  }

  // Add a new YOLO entry card
  window.ann2AddYoloEntry = async function (modelKey, selectedDevice = 'cuda:0') {
    // Close dropdown
    const dd = document.getElementById('ann2-yolo-model-dropdown');
    if (dd) dd.style.display = 'none';

    const container = document.getElementById('ann2-yolo-entries');
    if (!container) return;

    const entryId = 'yolo-entry-' + Date.now();
    const yoloNames = await _fetchYoloNames(modelKey);
    const dsNames = _ds?.classes?.names || [];

    const card = document.createElement('div');
    card.className = 'ann2-yolo-entry';
    card.dataset.model = modelKey;
    card.id = entryId;

    // ── Header: model dropdown + delete ──
    const header = document.createElement('div');
    header.className = 'ann2-yolo-entry-header';

    const modelLbl = document.createElement('span');
    modelLbl.style.cssText = 'font-size:.7rem;font-weight:700;color:#fb923c;text-transform:uppercase;letter-spacing:.05em;flex-shrink:0;';
    modelLbl.textContent = '⬡ YOLO';

    const modelSel = document.createElement('select');
    modelSel.className = 'ann2-yolo-model-sel';
    Object.entries(YOLO_MODELS).forEach(([k, v]) => {
      const o = document.createElement('option');
      o.value = k; o.textContent = v.label;
      if (k === modelKey) o.selected = true;
      modelSel.appendChild(o);
    });
    modelSel.onchange = async function () {
      card.dataset.model = this.value;
      // Refresh class pair dropdowns
      const newNames = await _fetchYoloNames(this.value);
      card.querySelectorAll('.ann2-yolo-yolo-sel').forEach(sel => {
        const cur = sel.value;
        _populateYoloClassSel(sel, newNames, cur);
      });
      ann2MarkSettingsDirty();
    };

    const delBtn = document.createElement('button');
    delBtn.className = 'ann2-yolo-del-btn';
    delBtn.title = 'Remove YOLO entry';
    delBtn.textContent = '✕';
    delBtn.onclick = () => { card.remove(); ann2MarkSettingsDirty(); };

    header.append(modelLbl, modelSel, delBtn);

    // Device selector row
    const deviceRow = document.createElement('div');
    deviceRow.style.cssText = 'display:flex; align-items:center; gap:8px; margin-top:2px; margin-bottom: 2px;';
    deviceRow.innerHTML = `
      <span style="font-size:.72rem; color:var(--text-muted); white-space:nowrap; min-width:28px;">GPU</span>
      <select class="ann2-yolo-device-sel" onchange="ann2MarkSettingsDirty()" style="flex:1; padding:4px 7px; background:var(--bg-tertiary); border:1px solid var(--border); border-radius:6px; color:var(--text-primary); font-family:inherit; font-size:.78rem; cursor:pointer;">
      </select>
    `;
    const deviceSel = deviceRow.querySelector('.ann2-yolo-device-sel');
    deviceSel.innerHTML = _gpuList.map(g => `<option value="${g.id}">${g.name}</option>`).join('');
    deviceSel.value = selectedDevice;

    // ── Conf slider ──
    const confId = entryId + '-conf-val';
    const confRow = _makeYoloSliderRow('Conf', entryId + '-conf', confId, 1, 99, 25, '%');

    // ── IoU slider ──
    const iouId = entryId + '-iou-val';
    const iouRow = _makeYoloSliderRow('IoU', entryId + '-iou', iouId, 1, 99, 45, '%');

    // ── Class pairs area ──
    const pairsLbl = document.createElement('div');
    pairsLbl.style.cssText = 'display:flex; justify-content:space-between; align-items:center;';
    pairsLbl.innerHTML = `
      <span style="font-size:.7rem;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:.05em;">YOLO Class → Dataset Class</span>
      <button onclick="ann2AddYoloPairRow(this)" style="font-size:.72rem;padding:2px 7px;border-radius:4px;border:1px solid rgba(251,146,60,0.3);background:rgba(251,146,60,0.08);color:#fb923c;cursor:pointer;">+ Pair</button>
    `;

    const pairsContainer = document.createElement('div');
    pairsContainer.className = 'ann2-yolo-pairs';
    pairsContainer.style.cssText = 'display:flex;flex-direction:column;gap:5px;';

    // Add one default pair
    _addYoloPairRowDOM(pairsContainer, yoloNames, dsNames, null, null);

    card.append(header, deviceRow, confRow, iouRow, pairsLbl, pairsContainer);
    container.appendChild(card);
    ann2MarkSettingsDirty();
  };

  function _makeYoloSliderRow(label, sliderId, valId, min, max, defVal, unit) {
    const row = document.createElement('div');
    row.className = 'ann2-yolo-slider-row';
    const lbl = document.createElement('span');
    lbl.className = 'lbl';
    lbl.textContent = label;
    const slider = document.createElement('input');
    slider.type = 'range';
    slider.id = sliderId;
    slider.min = min; slider.max = max; slider.value = defVal;
    const valEl = document.createElement('span');
    valEl.className = 'val';
    valEl.id = valId;
    valEl.textContent = defVal + (unit || '');
    slider.oninput = function () {
      // Enforce minimum 1%
      if (parseInt(this.value) < 1) this.value = 1;
      valEl.textContent = this.value + (unit || '');
      ann2MarkSettingsDirty();
    };
    row.append(lbl, slider, valEl);
    return row;
  }

  function _populateYoloClassSel(sel, names, selectedVal) {
    sel.innerHTML = '';
    names.forEach((n, i) => {
      const o = document.createElement('option');
      o.value = i; o.textContent = `${i}: ${n}`;
      if (String(i) === String(selectedVal)) o.selected = true;
      sel.appendChild(o);
    });
  }

  function _populateDsSel(sel, names, selectedVal) {
    sel.innerHTML = '';
    names.forEach((n, i) => {
      const o = document.createElement('option');
      o.value = i; o.textContent = `${i}: ${n}`;
      if (String(i) === String(selectedVal)) o.selected = true;
      sel.appendChild(o);
    });
  }

  function _addYoloPairRowDOM(container, yoloNames, dsNames, yoloClassId, dsClassId) {
    const row = document.createElement('div');
    row.className = 'ann2-yolo-class-pair';

    const yoloSel = document.createElement('select');
    yoloSel.className = 'ann2-yolo-yolo-sel';
    _populateYoloClassSel(yoloSel, yoloNames, yoloClassId !== null ? yoloClassId : 0);
    yoloSel.onchange = () => ann2MarkSettingsDirty();

    const arrow = document.createElement('span');
    arrow.className = 'ann2-pair-arrow';
    arrow.innerHTML = '→';

    const dsSel = document.createElement('select');
    dsSel.className = 'ann2-yolo-ds-sel';
    _populateDsSel(dsSel, dsNames, dsClassId !== null ? dsClassId : 0);
    dsSel.onchange = () => ann2MarkSettingsDirty();

    const delBtn = document.createElement('button');
    delBtn.className = 'ann2-pair-del';
    delBtn.textContent = '×';
    delBtn.title = 'Remove pair';
    delBtn.onclick = () => { row.remove(); ann2MarkSettingsDirty(); };

    row.append(yoloSel, arrow, dsSel, delBtn);
    container.appendChild(row);
  }

  window.ann2AddYoloPairRow = function (btn) {
    const card = btn.closest('.ann2-yolo-entry');
    if (!card) return;
    const pairsContainer = card.querySelector('.ann2-yolo-pairs');
    if (!pairsContainer) return;
    const modelKey = card.dataset.model;
    const yoloNames = _yoloClassCache[modelKey] || [];
    const dsNames = _ds?.classes?.names || [];
    _addYoloPairRowDOM(pairsContainer, yoloNames, dsNames, null, null);
    ann2MarkSettingsDirty();
  };

  // Collect YOLO entries from DOM into array for saving
  function _collectYoloEntries() {
    const entries = [];
    document.querySelectorAll('.ann2-yolo-entry').forEach(card => {
      const model = card.dataset.model;
      const confSlider = card.querySelector('[id$="-conf"]');
      const iouSlider = card.querySelector('[id$="-iou"]');
      const deviceSel = card.querySelector('.ann2-yolo-device-sel');
      const conf = confSlider ? (parseInt(confSlider.value) / 100) : 0.25;
      const iou = iouSlider ? (parseInt(iouSlider.value) / 100) : 0.45;
      const device = deviceSel ? deviceSel.value : 'cuda:0';
      const pairs = [];
      card.querySelectorAll('.ann2-yolo-class-pair').forEach(row => {
        const yc = parseInt(row.querySelector('.ann2-yolo-yolo-sel')?.value || 0);
        const dc = parseInt(row.querySelector('.ann2-yolo-ds-sel')?.value || 0);
        pairs.push({ yolo_class_id: yc, ds_class_id: dc });
      });
      entries.push({ model, conf, iou, device, pairs });
    });
    return entries;
  }

  // Render YOLO entries from saved settings
  async function _renderYoloEntries() {
    const container = document.getElementById('ann2-yolo-entries');
    if (!container) return;
    container.innerHTML = '';
    const entries = _autoAnnotateSettings.yolo_entries || [];
    for (const entry of entries) {
      const modelKey = entry.model || 'yolo26x-seg';
      const yoloNames = await _fetchYoloNames(modelKey);
      const dsNames = _ds?.classes?.names || [];

      const entryId = 'yolo-entry-' + Date.now() + Math.random();
      const card = document.createElement('div');
      card.className = 'ann2-yolo-entry';
      card.dataset.model = modelKey;
      card.id = entryId;

      const header = document.createElement('div');
      header.className = 'ann2-yolo-entry-header';
      const modelLbl = document.createElement('span');
      modelLbl.style.cssText = 'font-size:.7rem;font-weight:700;color:#fb923c;text-transform:uppercase;letter-spacing:.05em;flex-shrink:0;';
      modelLbl.textContent = '⬡ YOLO';
      const modelSel = document.createElement('select');
      modelSel.className = 'ann2-yolo-model-sel';
      Object.entries(YOLO_MODELS).forEach(([k, v]) => {
        const o = document.createElement('option');
        o.value = k; o.textContent = v.label;
        if (k === modelKey) o.selected = true;
        modelSel.appendChild(o);
      });
      modelSel.onchange = async function () {
        card.dataset.model = this.value;
        const newNames = await _fetchYoloNames(this.value);
        card.querySelectorAll('.ann2-yolo-yolo-sel').forEach(sel => {
          const cur = sel.value;
          _populateYoloClassSel(sel, newNames, cur);
        });
        ann2MarkSettingsDirty();
      };
      const delBtn2 = document.createElement('button');
      delBtn2.className = 'ann2-yolo-del-btn';
      delBtn2.title = 'Remove';
      delBtn2.textContent = '✕';
      delBtn2.onclick = () => { card.remove(); ann2MarkSettingsDirty(); };
      header.append(modelLbl, modelSel, delBtn2);

      // Device selector row
      const deviceRow = document.createElement('div');
      deviceRow.style.cssText = 'display:flex; align-items:center; gap:8px; margin-top:2px; margin-bottom: 2px;';
      deviceRow.innerHTML = `
        <span style="font-size:.72rem; color:var(--text-muted); white-space:nowrap; min-width:28px;">GPU</span>
        <select class="ann2-yolo-device-sel" onchange="ann2MarkSettingsDirty()" style="flex:1; padding:4px 7px; background:var(--bg-tertiary); border:1px solid var(--border); border-radius:6px; color:var(--text-primary); font-family:inherit; font-size:.78rem; cursor:pointer;">
        </select>
      `;
      const deviceSel = deviceRow.querySelector('.ann2-yolo-device-sel');
      deviceSel.innerHTML = _gpuList.map(g => `<option value="${g.id}">${g.name}</option>`).join('');
      deviceSel.value = entry.device || 'cuda:0';

      const confPct = Math.round((entry.conf || 0.25) * 100);
      const iouPct = Math.round((entry.iou || 0.45) * 100);
      const confRow = _makeYoloSliderRow('Conf', entryId + '-conf', entryId + '-conf-val', 1, 99, confPct, '%');
      const iouRow  = _makeYoloSliderRow('IoU',  entryId + '-iou',  entryId + '-iou-val',  1, 99, iouPct,  '%');

      const pairsLbl = document.createElement('div');
      pairsLbl.style.cssText = 'display:flex; justify-content:space-between; align-items:center;';
      pairsLbl.innerHTML = `
        <span style="font-size:.7rem;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:.05em;">YOLO Class → Dataset Class</span>
        <button onclick="ann2AddYoloPairRow(this)" style="font-size:.72rem;padding:2px 7px;border-radius:4px;border:1px solid rgba(251,146,60,0.3);background:rgba(251,146,60,0.08);color:#fb923c;cursor:pointer;">+ Pair</button>
      `;
      const pairsContainer = document.createElement('div');
      pairsContainer.className = 'ann2-yolo-pairs';
      pairsContainer.style.cssText = 'display:flex;flex-direction:column;gap:5px;';
      const pairs = entry.pairs || [];
      if (pairs.length === 0) {
        _addYoloPairRowDOM(pairsContainer, yoloNames, dsNames, null, null);
      } else {
        pairs.forEach(p => _addYoloPairRowDOM(pairsContainer, yoloNames, dsNames, p.yolo_class_id, p.ds_class_id));
      }

      card.append(header, deviceRow, confRow, iouRow, pairsLbl, pairsContainer);
      container.appendChild(card);
    }
  }

  // IoU computation (client-side)
  function _polygonIoU(polyA, polyB) {
    const SIZE = 128;
    const canv = document.createElement('canvas');
    canv.width = SIZE; canv.height = SIZE;
    const ctx = canv.getContext('2d');

    function raster(poly) {
      ctx.clearRect(0, 0, SIZE, SIZE);
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      poly.forEach((p, i) => {
        const x = p[0] * SIZE, y = p[1] * SIZE;
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      });
      ctx.closePath();
      ctx.fill();
      const data = ctx.getImageData(0, 0, SIZE, SIZE).data;
      const mask = new Uint8Array(SIZE * SIZE);
      for (let i = 0; i < mask.length; i++) mask[i] = data[i * 4] > 128 ? 1 : 0;
      return mask;
    }
    const mA = raster(polyA), mB = raster(polyB);
    let inter = 0, union = 0;
    for (let i = 0; i < mA.length; i++) {
      if (mA[i] && mB[i]) inter++;
      if (mA[i] || mB[i]) union++;
    }
    return union === 0 ? 0 : inter / union;
  }

  // Show/hide processing overlay
  function _showProcessing(show, detail) {
    const ov = document.getElementById('ann2-processing-overlay');
    if (ov) ov.style.display = show ? 'flex' : 'none';
    const det = document.getElementById('ann2-processing-detail');
    if (det) det.textContent = detail || '';
  }

  // Start auto annotate (S key)
  window.ann2StartAutoAnnotate = async function () {
    if (!_ds || !_images.length || _autoProcessing) return;
    const isNoneModel = _autoAnnotateSettings.model === 'none';
    const hasYolo = (_autoAnnotateSettings.yolo_entries || []).length > 0;

    if (!isNoneModel && (!_autoAnnotateSettings.prompts || _autoAnnotateSettings.prompts.length === 0)) {
      if (window.toast) toast('Set prompts dulu di settings panel', 'err');
      return;
    }
    if (isNoneModel && !hasYolo) {
      if (window.toast) toast('Tambahkan minimal satu YOLO entry', 'err');
      return;
    }

    _autoProcessing = true;
    const startMsg = hasYolo ? 'YOLO Detection...' : `SAM ${_autoAnnotateSettings.model} — ${_images[_idx]?.filename || ''}`;
    _showProcessing(true, startMsg);

    try {
      const imgObj = _images[_idx];

      // ── Collect all candidate annotations ──
      let allAnnotations = [];

      // 1) YOLO entries (processed first to prioritize YOLO)
      if (hasYolo) {
        _showProcessing(true, `Running YOLO detectors...`);
        for (const entry of (_autoAnnotateSettings.yolo_entries || [])) {
          try {
            const yr = await fetch(`/api/dataset/${encodeURIComponent(_ds.name)}/yolo-detect`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                filename: imgObj.filename,
                model: entry.model,
                conf: entry.conf || 0.25,
                device: entry.device || 'cuda:0',
                pairs: entry.pairs || []
              })
            });
            const yd = await yr.json();
            if (yr.ok && yd.success && yd.annotations) {
              allAnnotations = allAnnotations.concat(yd.annotations.map(a => ({
                class_id: a.class_id,
                points: a.points.map(p => [...p]),
                type: a.type || 'bbox',
                _iou_threshold: entry.iou || 0.45
              })));
            } else {
              if (window.toast) toast(yd.error || 'YOLO detect failed', 'err');
            }
          } catch (ye) {
            console.warn('YOLO detect error:', ye);
            if (window.toast) toast(ye.message || 'YOLO detect error', 'err');
          }
        }
      }

      // 2) SAM auto-annotate (unless None)
      if (!isNoneModel) {
        _showProcessing(true, `SAM ${_autoAnnotateSettings.model} — ${imgObj.filename || ''}`);
        const resp = await fetch(`/api/dataset/${encodeURIComponent(_ds.name)}/sam-auto-annotate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            filename: imgObj.filename,
            model: _autoAnnotateSettings.model,
            prompts: _autoAnnotateSettings.prompts,
            conf: _autoAnnotateSettings.conf || 0.25,
            iou: _autoAnnotateSettings.iou || 0.85,
            device: _autoAnnotateSettings.device || 'cuda:0',
            recheck: !!_autoAnnotateSettings.recheck,
            recheck_model: _autoAnnotateSettings.recheck_model || 'sam3',
            recheck_device: _autoAnnotateSettings.recheck_device || 'cuda:0',
            recheck_min_area: _autoAnnotateSettings.recheck_min_area !== undefined ? _autoAnnotateSettings.recheck_min_area : 0.70,
            recheck_max_area: _autoAnnotateSettings.recheck_max_area !== undefined ? _autoAnnotateSettings.recheck_max_area : 1.20,
            recheck_imgsz: _autoAnnotateSettings.recheck_imgsz !== undefined ? _autoAnnotateSettings.recheck_imgsz : 1024
          })
        });
        const data = await resp.json();
        if (resp.ok && data.success && data.annotations) {
          allAnnotations = allAnnotations.concat(data.annotations.map(a => ({
            class_id: a.class_id,
            points: a.points.map(p => [...p]),
            type: 'polygon',
            _iou_threshold: _autoAnnotateSettings.iou || 0.85
          })));
        } else if (!resp.ok || !data.success) {
          if (window.toast) toast(data.error || 'SAM failed', 'err');
        }
      }

      // ── Apply IoU filtering against existing and accepted annotations ──
      _iouRejectedAnns = [];
      const filteredAnns = [];
      for (const newAnn of allAnnotations) {
        const iouThreshold = newAnn._iou_threshold;
        let isDup = false;
        const newPoly = newAnn.type === 'bbox'
          ? [[newAnn.points[0][0], newAnn.points[0][1]], [newAnn.points[1][0], newAnn.points[0][1]], [newAnn.points[1][0], newAnn.points[1][1]], [newAnn.points[0][0], newAnn.points[1][1]]]
          : newAnn.points;

        // 1) Compare against existing annotations on the canvas (_anns)
        for (const existing of _anns) {
          const existPoly = existing.type === 'bbox'
            ? [[existing.points[0][0], existing.points[0][1]], [existing.points[1][0], existing.points[0][1]], [existing.points[1][0], existing.points[1][1]], [existing.points[0][0], existing.points[1][1]]]
            : existing.points;
          if (_polygonIoU(newPoly, existPoly) > iouThreshold) {
            isDup = true;
            break;
          }
        }

        // 2) Compare against already accepted annotations in this scan (filteredAnns)
        if (!isDup) {
          for (const existing of filteredAnns) {
            const existPoly = existing.type === 'bbox'
              ? [[existing.points[0][0], existing.points[0][1]], [existing.points[1][0], existing.points[0][1]], [existing.points[1][0], existing.points[1][1]], [existing.points[0][0], existing.points[1][1]]]
              : existing.points;

            // If same class, deduplicate with 0.5 threshold.
            // If different class, only deduplicate if almost identical (0.85).
            const overlapLimit = (newAnn.class_id === existing.class_id) ? 0.5 : 0.85;
            if (_polygonIoU(newPoly, existPoly) > overlapLimit) {
              isDup = true;
              break;
            }
          }
        }

        if (isDup) {
          _iouRejectedAnns.push({
            class_id: newAnn.class_id,
            points: newPoly.map(p => [...p]),
            type: 'polygon'
          });
        } else {
          filteredAnns.push(newAnn);
        }
      }

      if (filteredAnns.length > 0 || _iouRejectedAnns.length > 0) {
        if (_autoAnnotateActive) {
          // Checked mode: add permanently
          _pushUndoState();
          let added = 0;
          filteredAnns.forEach(newAnn => {
            _anns.push({
              class_id: newAnn.class_id,
              points: newAnn.points.map(p => [...p]),
              type: newAnn.type || 'polygon',
              locked: false
            });
            added++;
          });
          if (window.toast) toast(`Auto annotate: ${added} annotations added${_iouRejectedAnns.length ? ` (${_iouRejectedAnns.length} IoU dup)` : ''}`);
          _selIdx = _anns.length - 1;
          _renderAnnList();
          _redraw();
          await ann2ApproveAutoAnnotate();
        } else {
          // Unchecked mode: store as temporary preview
          _tempAutoAnns = filteredAnns.map(newAnn => ({
            class_id: newAnn.class_id,
            points: newAnn.type === 'bbox'
              ? [[newAnn.points[0][0], newAnn.points[0][1]], [newAnn.points[1][0], newAnn.points[0][1]], [newAnn.points[1][0], newAnn.points[1][1]], [newAnn.points[0][0], newAnn.points[1][1]]]
              : newAnn.points.map(p => [...p]),
            type: 'polygon'
          }));
          _tempAnnSelIdx = -1; _tempAnnHoverIdx = -1;
          if (window.toast) toast(`Scanned: ${_tempAutoAnns.length} obj${_iouRejectedAnns.length ? ` (${_iouRejectedAnns.length} IoU dup)` : ''}. Enter = confirm, Esc = cancel`);
          _redraw();
        }
      } else {
        if (window.toast) toast(allAnnotations.length > 0 ? `All ${allAnnotations.length} results rejected by IoU overlap` : 'No annotations found', 'err');
        if (_autoAnnotateActive) {
          await ann2ApproveAutoAnnotate();
        }
      }
    } catch (e) {
      if (window.toast) toast('Auto annotate error: ' + e.message, 'err');
    }

    _autoProcessing = false;
    _showProcessing(false);
  };

  // Approve auto annotate (S key checked-mode auto-loop, or Enter manually)
  window.ann2ApproveAutoAnnotate = async function () {
    if (!_ds || !_images.length) return;

    // Add tags if configured
    if (_autoAnnotateSettings.on_approved_tags && _autoAnnotateSettings.on_approved_tags.length > 0) {
      _autoAnnotateSettings.on_approved_tags.forEach(tag => {
        if (!_curTags.includes(tag)) _curTags.push(tag);
      });
      _renderTagsArea();

      // Save tags to server
      try {
        const imgObj = _images[_idx];
        await fetch(`/api/dataset/${encodeURIComponent(_ds.name)}/image-tags`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filenames: [imgObj.filename], tags: _curTags })
        });
      } catch (e) { console.error('Failed to save tags', e); }
    }

    // Save annotations
    await ann2Save();

    // Next image
    if (_idx < _images.length - 1) {
      _loadImg(_idx + 1);

      // If auto loop is still active, trigger prediction automatically
      if (_autoAnnotateActive) {
        setTimeout(async () => {
          if (_autoAnnotateActive) {
            await ann2StartAutoAnnotate();
          }
        }, 500);
      }
    } else {
      if (window.toast) toast('Semua gambar sudah di-annotate ✓');
    }
  };

  // Helper functions for preview confirm & cancel
  function _confirmTempAutoAnns() {
    if (!_tempAutoAnns || _tempAutoAnns.length === 0) return;
    _pushUndoState();
    let added = 0;
    _tempAutoAnns.forEach(newAnn => {
      let isDup = false;
      for (const existing of _anns) {
        if (existing.type === 'polygon' || existing.type === 'bbox') {
          const existPoly = existing.type === 'bbox'
            ? [[existing.points[0][0], existing.points[0][1]], [existing.points[1][0], existing.points[0][1]], [existing.points[1][0], existing.points[1][1]], [existing.points[0][0], existing.points[1][1]]]
            : existing.points;
          const iou = _polygonIoU(newAnn.points, existPoly);
          if (iou > 0.85) { isDup = true; break; }
        }
      }
      if (!isDup) {
        _anns.push({
          class_id: newAnn.class_id,
          points: newAnn.points.map(p => [...p]),
          type: 'polygon',
          locked: false
        });
        added++;
      }
    });
    if (window.toast) toast(`Confirmed: ${added} segments saved`);
    _tempAutoAnns = [];
    _selIdx = _anns.length - 1;
    _tempAnnSelectedVertex = -1;
    _renderAnnList();
    _redraw();
    _updateShortcutHints();
    if (_autosave) ann2Save();
  }

  function _clearTempAutoAnns() {
    if (!_tempAutoAnns || _tempAutoAnns.length === 0) return;
    _tempAutoAnns = [];
    _tempAnnSelIdx = -1; _tempAnnHoverIdx = -1;
    _tempAnnSelectedVertex = -1;
    _iouRejectedAnns = [];
    _hideSimplifypanel();
    _redraw();
    _updateShortcutHints();
    if (window.toast) toast('Scan cancelled');
  }

  // ── Simplify Polygon (Ramer-Douglas-Peucker) ──
  function _rdpReduce(pts, eps) {
    if (pts.length <= 2) return pts;
    let dmax = 0, idx = 0;
    const end = pts.length - 1;
    for (let i = 1; i < end; i++) {
      // perpendicular distance from pts[i] to line pts[0]..pts[end]
      const x0 = pts[0][0], y0 = pts[0][1], x1 = pts[end][0], y1 = pts[end][1];
      const xi = pts[i][0], yi = pts[i][1];
      const dx = x1 - x0, dy = y1 - y0;
      const len = Math.sqrt(dx*dx + dy*dy);
      const d = len > 0 ? Math.abs(dy*xi - dx*yi + x1*y0 - y1*x0) / len : Math.sqrt((xi-x0)**2+(yi-y0)**2);
      if (d > dmax) { dmax = d; idx = i; }
    }
    if (dmax > eps) {
      const r1 = _rdpReduce(pts.slice(0, idx + 1), eps);
      const r2 = _rdpReduce(pts.slice(idx), eps);
      return [...r1.slice(0, -1), ...r2];
    }
    return [pts[0], pts[end]];
  }

  function _simplifyPolygon(pts, pct) {
    // pct: 0..100, 100 = original, 1 = very simplified
    if (!pts || pts.length < 4) return pts;
    const maxEps = 0.05; // max epsilon in normalised coords
    const eps = maxEps * (1 - pct / 100);
    if (eps <= 0) return pts;
    const closed = [...pts, pts[0]];
    const reduced = _rdpReduce(closed, eps);
    const result = reduced.slice(0, -1);
    return result.length >= 3 ? result : pts.slice(0, 3);
  }

  function _checkSimplifyPanelVisibility() {
    let show = false;
    let targetPts = null;

    if (_tool === 'autoann') {
      if (_tempAnnSelIdx >= 0 && _tempAutoAnns[_tempAnnSelIdx]) {
        show = true;
        targetPts = _tempAutoAnns[_tempAnnSelIdx].points;
      }
    } else if (_tool === 'edit') {
      if (_selIdx >= 0 && _anns[_selIdx] && _anns[_selIdx].type === 'polygon') {
        show = true;
        targetPts = _anns[_selIdx].points;
      }
    } else if (_tool === 'magic') {
      if (_magicReplaceIdx >= 0 && _anns[_magicReplaceIdx] && _anns[_magicReplaceIdx].type === 'polygon') {
        show = true;
        targetPts = _anns[_magicReplaceIdx].points;
      }
    }

    const currentTargetKey = show && targetPts
      ? `${_tool}_${_tool === 'autoann' ? _tempAnnSelIdx : (_tool === 'magic' ? _magicReplaceIdx : _selIdx)}`
      : null;

    if (_activeSimplifyTargetKey !== currentTargetKey) {
      if (_simplifyDirty && _tempAnnOrigPts && _activeSimplifyTargetKey) {
        const parts = _activeSimplifyTargetKey.split('_');
        const prevTool = parts[0];
        const prevIdx = parseInt(parts[1]);
        if (prevTool === 'autoann') {
          if (_tempAutoAnns[prevIdx]) {
            _tempAutoAnns[prevIdx].points = _tempAnnOrigPts.map(p => [...p]);
          }
        } else if (prevTool === 'edit') {
          if (_anns[prevIdx]) {
            _anns[prevIdx].points = _tempAnnOrigPts.map(p => [...p]);
          }
        } else if (prevTool === 'magic') {
          if (_anns[prevIdx]) {
            _anns[prevIdx].points = _tempAnnOrigPts.map(p => [...p]);
          }
        }
      }

      _activeSimplifyTargetKey = currentTargetKey;

      if (show && targetPts) {
        _showSimplifyPanel(targetPts);
      } else {
        _hideSimplifypanel();
      }
      _redraw();
    }
  }

  // ── Simplify Panel ──
  function _showSimplifyPanel(points) {
    const panel = document.getElementById('ann2-simplify-panel');
    if (!panel) return;
    panel.style.display = 'flex';
    const slider = document.getElementById('ann2-simplify-slider');
    const valEl = document.getElementById('ann2-simplify-val');
    const applyBtn = document.getElementById('ann2-simplify-apply');
    if (slider) slider.value = 100;
    if (valEl) valEl.textContent = '100%';
    if (applyBtn) { applyBtn.disabled = true; }
    _simplifyDirty = false;
    _tempAnnOrigPts = points.map(p => [...p]);
  }

  function _hideSimplifypanel() {
    const panel = document.getElementById('ann2-simplify-panel');
    if (panel) panel.style.display = 'none';
    _simplifyDirty = false;
    _tempAnnOrigPts = null;
  }

  window.ann2OnSimplifySlider = function (val) {
    const valEl = document.getElementById('ann2-simplify-val');
    if (valEl) valEl.textContent = val + '%';
    const applyBtn = document.getElementById('ann2-simplify-apply');
    const isDirty = parseInt(val) !== 100;
    if (applyBtn) { applyBtn.disabled = !isDirty; }
    _simplifyDirty = isDirty;
    if (!_tempAnnOrigPts) return;
    const pct = parseInt(val);
    const simplifiedPts = pct === 100
      ? _tempAnnOrigPts.map(p => [...p])
      : _simplifyPolygon(_tempAnnOrigPts, pct);

    if (_tool === 'autoann' && _tempAnnSelIdx >= 0 && _tempAutoAnns[_tempAnnSelIdx]) {
      _tempAutoAnns[_tempAnnSelIdx].points = simplifiedPts;
    } else if (_tool === 'edit' && _selIdx >= 0 && _anns[_selIdx]) {
      _anns[_selIdx].points = simplifiedPts;
    } else if (_tool === 'magic' && _magicReplaceIdx >= 0 && _anns[_magicReplaceIdx]) {
      _anns[_magicReplaceIdx].points = simplifiedPts;
    }
    _redraw();
  };

  window.ann2ApplySimplify = function () {
    const applyBtn = document.getElementById('ann2-simplify-apply');
    if (applyBtn?.disabled) return;

    if (_tool === 'edit' || _tool === 'magic') {
      _pushUndoState();
    }

    let currentPts = null;
    if (_tool === 'autoann' && _tempAnnSelIdx >= 0 && _tempAutoAnns[_tempAnnSelIdx]) {
      currentPts = _tempAutoAnns[_tempAnnSelIdx].points;
    } else if (_tool === 'edit' && _selIdx >= 0 && _anns[_selIdx]) {
      currentPts = _anns[_selIdx].points;
    } else if (_tool === 'magic' && _magicReplaceIdx >= 0 && _anns[_magicReplaceIdx]) {
      currentPts = _anns[_magicReplaceIdx].points;
    }

    if (currentPts) {
      _tempAnnOrigPts = currentPts.map(p => [...p]);
    }

    const slider = document.getElementById('ann2-simplify-slider');
    const valEl = document.getElementById('ann2-simplify-val');
    if (slider) slider.value = 100;
    if (valEl) valEl.textContent = '100%';
    if (applyBtn) applyBtn.disabled = true;
    _simplifyDirty = false;
    if (window.toast) toast('Simplify applied ✓');
    if ((_tool === 'edit' || _tool === 'magic') && _autosave) {
      ann2Save();
    }
  };

  // ── IoU Rejected Toggle ──
  window.ann2ToggleIouRejected = function () {
    _showIouRejected = !_showIouRejected;
    const btn = document.getElementById('ann2-iou-toggle');
    if (btn) btn.classList.toggle('iou-active', _showIouRejected);
    _redraw();
    if (window.toast) toast(_showIouRejected ? `Showing ${_iouRejectedAnns.length} IoU-rejected outlines` : 'IoU overlay hidden');
  };

})();
