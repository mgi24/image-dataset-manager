// Annodes JavaScript node editor with Multiple Pins & Resize Observer

(function () {
  let _nodes = [];
  let _connections = [];
  let _selectedNodeId = null;
  
  // Dragging connection state
  let _draftConn = null;

  // Available models & GPUs cached
  let _cachedModels = [];
  let _cachedGpus = [];
  let _aiModels = [];
  let _aiEndpoints = [];

  // DOM elements
  const canvasWrap = document.getElementById('canvas-wrap');
  const canvasContent = document.getElementById('canvas-content');
  const nodesContainer = document.getElementById('nodes-container');
  const svgOverlay = document.getElementById('node-svg-overlay');

  // Panning & Zooming State
  let _panX = 0;
  let _panY = 0;
  let _zoom = 1.0;
  let _isPanning = false;
  let _startPanMouseX = 0;
  let _startPanMouseY = 0;
  let _startPanX = 0;
  let _startPanY = 0;

  function adjustZoom(zoomIn) {
    const wrapRect = canvasWrap.getBoundingClientRect();
    const centerX = wrapRect.width / 2;
    const centerY = wrapRect.height / 2;

    const canvasX = (centerX - _panX) / _zoom;
    const canvasY = (centerY - _panY) / _zoom;

    if (zoomIn) {
      _zoom = Math.min(_zoom * 1.15, 2.5);
    } else {
      _zoom = Math.max(_zoom / 1.15, 0.15);
    }

    _panX = centerX - canvasX * _zoom;
    _panY = centerY - canvasY * _zoom;

    canvasContent.style.transform = `translate(${_panX}px, ${_panY}px) scale(${_zoom})`;
    localStorage.setItem('annodes_pan_x', _panX);
    localStorage.setItem('annodes_pan_y', _panY);
    localStorage.setItem('annodes_zoom', _zoom);

    renderConnections();
  }

  function resetZoom() {
    _zoom = 1.0;
    _panX = 0;
    _panY = 0;
    canvasContent.style.transform = `translate(${_panX}px, ${_panY}px) scale(${_zoom})`;
    localStorage.setItem('annodes_pan_x', _panX);
    localStorage.setItem('annodes_pan_y', _panY);
    localStorage.setItem('annodes_zoom', _zoom);
    renderConnections();
  }

  // --- Tab Management ---
  let _tabs = [];
  let _activeTabId = null;
  let activeDropdown = null;

  async function loadTabs() {
    try {
      const r = await fetch('/api/tabs');
      if (r.ok) {
        _tabs = await r.json();
        const active = _tabs.find(t => t.is_active);
        _activeTabId = active ? active.id : null;
        renderTabs();
      }
    } catch (err) {
      console.error("Failed to load tabs", err);
    }
  }

  function renderTabs() {
    const container = document.getElementById('tabs-container');
    if (!container) return;
    container.innerHTML = '';

    _tabs.forEach(tab => {
      const tabEl = document.createElement('div');
      tabEl.className = `tab ${tab.id === _activeTabId ? 'active' : ''}`;
      
      const tabName = document.createElement('span');
      tabName.textContent = tab.name;
      tabEl.appendChild(tabName);

      const optBtn = document.createElement('button');
      optBtn.className = 'tab-options-btn';
      optBtn.textContent = '⋮';
      optBtn.title = 'Tab Options';
      optBtn.onclick = (e) => {
        e.stopPropagation();
        showTabDropdown(e, tab);
      };
      tabEl.appendChild(optBtn);

      tabEl.onclick = () => {
        if (tab.id !== _activeTabId) {
          selectTab(tab.id);
        }
      };

      container.appendChild(tabEl);
    });
  }

  async function selectTab(tabId, skipPushState = false) {
    try {
      const r = await fetch('/api/tabs/select', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: tabId })
      });
      if (r.ok) {
        const data = await r.json();
        _activeTabId = data.tab_id;
        
        if (!skipPushState) {
          window.history.pushState(null, '', '/' + data.tab_id);
        }
        
        nodesContainer.innerHTML = '';
        _nodes = data.nodes || [];
        _connections = data.connections || [];
        _nodes.forEach(n => renderNodeDOM(n));
        renderConnections();

        await loadTabs();
        showToast(`Loaded flow: ${data.tab_name}`, 'success');
      }
    } catch (err) {
      showToast('Gagal memuat flow.', 'error');
    }
  }

  async function createTab(name) {
    try {
      const r = await fetch('/api/tabs/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name })
      });
      if (r.ok) {
        const res = await r.json();
        await selectTab(res.id);
        showToast(`Tab '${name}' berhasil dibuat!`, 'success');
      }
    } catch (err) {
      showToast('Gagal membuat tab baru.', 'error');
    }
  }

  async function renameTab(tabId, oldName) {
    const newName = prompt('Ubah nama flow:', oldName);
    if (!newName || newName.trim() === '') return;
    try {
      const r = await fetch('/api/tabs/rename', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: tabId, name: newName.trim() })
      });
      if (r.ok) {
        await loadTabs();
        showToast('Nama flow berhasil diubah.', 'success');
      }
    } catch (err) {
      showToast('Gagal mengubah nama flow.', 'error');
    }
  }

  async function deleteTab(tabId, name) {
    if (!confirm(`Apakah Anda yakin ingin menghapus flow '${name}'?`)) return;
    try {
      const r = await fetch('/api/tabs/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: tabId })
      });
      if (r.ok) {
        await loadCanvas();
        await loadTabs();
        showToast('Flow berhasil dihapus.', 'success');
      }
    } catch (err) {
      showToast('Gagal menghapus flow.', 'error');
    }
  }

  function showTabDropdown(e, tab) {
    closeTabDropdown();

    const dropdown = document.createElement('div');
    dropdown.className = 'tab-dropdown';
    
    const renameBtn = document.createElement('button');
    renameBtn.className = 'tab-dropdown-item';
    renameBtn.textContent = 'Rename';
    renameBtn.onclick = (event) => {
      event.stopPropagation();
      closeTabDropdown();
      renameTab(tab.id, tab.name);
    };

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'tab-dropdown-item delete';
    deleteBtn.textContent = 'Delete';
    deleteBtn.onclick = (event) => {
      event.stopPropagation();
      closeTabDropdown();
      deleteTab(tab.id, tab.name);
    };

    dropdown.appendChild(renameBtn);
    dropdown.appendChild(deleteBtn);

    const rect = e.target.getBoundingClientRect();
    dropdown.style.left = (rect.left + window.scrollX) + 'px';
    dropdown.style.top = (rect.bottom + window.scrollY) + 'px';

    document.body.appendChild(dropdown);
    activeDropdown = dropdown;

    setTimeout(() => {
      window.addEventListener('click', closeTabDropdown);
    }, 0);
  }

  function closeTabDropdown() {
    if (activeDropdown) {
      activeDropdown.remove();
      activeDropdown = null;
    }
    window.removeEventListener('click', closeTabDropdown);
  }

  // --- Initializer ---
  async function init() {
    // Register sidebar template triggers
    document.querySelectorAll('.node-template-btn').forEach(btn => {
      btn.onclick = () => {
        const type = btn.getAttribute('data-type');
        createNode(type, 100 + Math.random() * 80, 100 + Math.random() * 80);
      };
    });

    // Load available models and GPUs from server
    await fetchModels();
    await fetchGpus();
    await fetchAiConfig();

    // Load saved canvas layout
    await loadCanvas();

    // Load tabs list
    await loadTabs();

    // Bind add-tab-btn click
    const addTabBtn = document.getElementById('add-tab-btn');
    if (addTabBtn) {
      addTabBtn.onclick = () => {
        const name = prompt('Masukkan nama flow baru:', `Flow ${_tabs.length + 1}`);
        if (name && name.trim() !== '') {
          createTab(name.trim());
        }
      };
    }

    // Restore pan & zoom state
    _panX = parseFloat(localStorage.getItem('annodes_pan_x')) || 0;
    _panY = parseFloat(localStorage.getItem('annodes_pan_y')) || 0;
    _zoom = parseFloat(localStorage.getItem('annodes_zoom')) || 1.0;
    canvasContent.style.transform = `translate(${_panX}px, ${_panY}px) scale(${_zoom})`;

    document.getElementById('zoom-in-btn').onclick = () => adjustZoom(true);
    document.getElementById('zoom-out-btn').onclick = () => adjustZoom(false);
    document.getElementById('zoom-reset-btn').onclick = () => resetZoom();

    // Mouse down listener for panning
    canvasWrap.onmousedown = (e) => {
      const isMiddle = e.button === 1;
      const isLeftOnBg = e.button === 0 && (e.target === canvasWrap || e.target === nodesContainer || e.target === svgOverlay);
      
      if (isMiddle || isLeftOnBg) {
        e.preventDefault();
        _isPanning = true;
        _startPanMouseX = e.clientX;
        _startPanMouseY = e.clientY;
        _startPanX = _panX;
        _startPanY = _panY;
        canvasWrap.style.cursor = 'grabbing';
      }
    };

    // Prevent default middle click scroll behavior
    canvasWrap.addEventListener('mousedown', (e) => {
      if (e.button === 1) e.preventDefault();
    });

    // Zoom on wheel (Zoom-to-mouse)
    canvasWrap.onwheel = (e) => {
      // If wheel event happens inside a node card, do not scroll/zoom the canvas
      if (e.target.closest('.node')) {
        return; 
      }
      
      e.preventDefault();
      
      const zoomFactor = 1.08;
      const wrapRect = canvasWrap.getBoundingClientRect();
      const mouseX = e.clientX - wrapRect.left;
      const mouseY = e.clientY - wrapRect.top;
      
      // Target coordinates in canvas space before zoom change
      const canvasX = (mouseX - _panX) / _zoom;
      const canvasY = (mouseY - _panY) / _zoom;
      
      // Calculate new zoom
      if (e.deltaY < 0) {
        _zoom = Math.min(_zoom * zoomFactor, 2.5); // max zoom 2.5
      } else {
        _zoom = Math.max(_zoom / zoomFactor, 0.15); // min zoom 0.15
      }
      
      // Calculate new pan to keep mouse over the same canvas spot
      _panX = mouseX - canvasX * _zoom;
      _panY = mouseY - canvasY * _zoom;
      
      canvasContent.style.transform = `translate(${_panX}px, ${_panY}px) scale(${_zoom})`;
      localStorage.setItem('annodes_pan_x', _panX);
      localStorage.setItem('annodes_pan_y', _panY);
      localStorage.setItem('annodes_zoom', _zoom);
      
      renderConnections();
    };

    // Mouse move/up listeners for connection drawing
    document.addEventListener('mousemove', onDocumentMouseMove);
    document.addEventListener('mouseup', onDocumentMouseUp);

    // Initial render
    renderAll();

    // Bind window popstate to support browser Back/Forward tab switching
    window.addEventListener('popstate', async () => {
      const path = window.location.pathname.substring(1);
      if (/^\d+$/.test(path)) {
        await selectTab(parseInt(path), true);
      }
    });
  }

  // --- API Fetchers ---
  async function fetchModels() {
    try {
      const r = await fetch('/api/models');
      const d = await r.json();
      if (Array.isArray(d)) {
        _cachedModels = d;
      } else if (d && d.models) {
        _cachedModels = d.models;
      }
    } catch (e) { console.warn('Failed to fetch models', e); }
  }

  async function fetchGpus() {
    try {
      const r = await fetch('/api/gpus');
      const d = await r.json();
      if (d.success) _cachedGpus = d.gpus || [];
    } catch (e) { console.warn('Failed to fetch GPUs', e); }

    // Ensure CPU is always an option in the list
    if (!_cachedGpus.some(g => g.id === 'cpu')) {
      _cachedGpus.push({ id: 'cpu', name: 'CPU' });
    }
  }

  async function fetchAiConfig() {
    try {
      const r = await fetch('/api/ai-decision/config');
      const d = await r.json();
      _aiModels = d.models || [];
      _aiEndpoints = d.endpoints || [];
    } catch (e) {
      console.warn('Failed to fetch AI Decision config', e);
    }
  }

  async function saveAiConfig() {
    try {
      await fetch('/api/ai-decision/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoints: _aiEndpoints, models: _aiModels })
      });
    } catch (e) {
      console.error('Failed to save AI Decision config', e);
    }
  }

  // --- Node Editor Core Operations ---
  function createNode(type, x, y, savedNode = null) {
    const id = savedNode ? savedNode.id : 'node-' + Date.now() + '-' + Math.floor(Math.random()*1000);
    
    // Default properties
    let properties = {};
    if (savedNode) {
      properties = savedNode.properties;
    } else {
      if (type === 'single_image') {
        properties = {
          image_path: 'test.jpg',
          annotation_path: '',
          classes: [
            { name: 'person', color: '#10b981' },
            { name: 'car', color: '#3b82f6' }
          ]
        };
      } else if (type === 'folder') {
        properties = {
          images_dir: '',
          labels_dir: '',
          classes: [
            { name: 'person', color: '#10b981' },
            { name: 'car', color: '#3b82f6' }
          ]
        };
      } else if (type === 'yolo_detector') {
        properties = {
          model: _cachedModels[0] || 'yolov8x-seg.pt',
          imgsz: 640,
          conf: 0.25,
          verbose: false,
          device: _cachedGpus[0]?.id || 'cuda:0',
          class_bindings: {},
          last_preview: null,
          last_logs: null,
          preview_width: 280,
          preview_height: 140
        };
      } else if (type === 'sam3') {
        properties = {
          model: 'sam3.pt',
          imgsz: 640,
          conf: 0.25,
          verbose: false,
          device: _cachedGpus[0]?.id || 'cuda:0',
          prompt_bindings: {},
          last_preview: null,
          last_logs: null,
          preview_width: 280,
          preview_height: 140
        };
      } else if (type === 'preview') {
        properties = {
          last_preview: null,
          preview_width: 320,
          preview_height: 240
        };
      } else if (type === 'overlap_comparator') {
        properties = {
          input_pins: ['image', 'annotation1', 'annotation2'],
          iou_threshold: 0.5,
          comparator_rules: [],
          last_preview: null,
          preview_width: 320,
          preview_height: 240
        };
      } else if (type === 'ai_decision') {
        properties = {
          input_pins: ['image', 'class', 'annotation1', 'annotation2'],
          model: '',
          class_rules: {
            'semua mobil kecil, minibus, termasuk mobil bak terbuka, kecualikan mobil dengan box bak tertutup.': '0'
          },
          global_rules: 'anda adalah manager dataset yang bertugas decide hasil dari deteksi sudah benar atau belum, compare mana yang bagus maskingnya, output json.',
          global_rules_height: 90,
          prompt_preview_height: 140,
          logs_height: 60,
          node_width: null,
          last_preview: null,
          last_logs: null,
          preview_width: 320,
          preview_height: 240
        };
      } else if (type === 'pointer') {
        properties = {
          points: [],
          active_mode: 'positive',
          last_preview: null,
          preview_width: 320,
          preview_height: 240
        };
      } else if (type === 'save_annotation') {
        properties = {
          output_dir: '',
          last_logs: null
        };
      }
    }

    const node = { id, type, x, y, properties };
    _nodes.push(node);
    
    renderNodeDOM(node);
    saveCanvas();
    
    // If connected inputs exist, we should refresh bindings
    if (type === 'yolo_detector') {
      refreshYoloBindings(id);
    } else if (type === 'sam3') {
      refreshSam3Bindings(id);
    } else if (type === 'ai_decision') {
      refreshAiDecisionRules(id);
    } else {
      // Refresh connected YOLO/SAM3/AI Decision nodes
      refreshAllYoloBindings();
    }
  }

  function deleteNode(id) {
    // Remove connections associated with this node
    _connections = _connections.filter(c => c.fromNodeId !== id && c.toNodeId !== id);
    
    // Remove from array
    _nodes = _nodes.filter(n => n.id !== id);
    
    // Remove DOM element
    const el = document.getElementById(id);
    if (el) el.remove();
    
    renderConnections();
    saveCanvas();
    refreshAllYoloBindings();
  }

  function refreshNodeDOM(node) {
    const oldEl = document.getElementById(node.id);
    if (!oldEl) return;
    oldEl.remove();
    renderNodeDOM(node);
    renderConnections();
  }

  // --- Pins Layout Helper ---
  function createPinsLayout(node, inputs, outputs) {
    const container = document.createElement('div');
    container.className = 'pins-container';

    // Inputs Column (Left)
    const inCol = document.createElement('div');
    inCol.className = 'pins-column pins-column-in';
    inputs.forEach(pin => {
      const row = document.createElement('div');
      row.className = 'pin-row';
      
      const pinEl = document.createElement('div');
      pinEl.className = 'pin pin-in';
      pinEl.dataset.nodeId = node.id;
      pinEl.dataset.pinName = pin.name;
      pinEl.dataset.pinType = 'in';
      
      // Check if connected
      const isConnected = _connections.some(c => c.toNodeId === node.id && c.toPinName === pin.name);
      if (isConnected) pinEl.classList.add('connected');
      
      const label = document.createElement('span');
      label.className = 'pin-label';
      label.textContent = pin.label;
      if (pin.optional) {
        label.textContent += ' (opt)';
        label.style.opacity = '0.6';
      }

      row.append(pinEl, label);

      if ((node.type === 'overlap_comparator' || node.type === 'ai_decision') && pin.name.startsWith('annotation')) {
        const removePinBtn = document.createElement('button');
        removePinBtn.textContent = '✕';
        removePinBtn.style.cssText = 'border:none; background:none; color:var(--text-muted); cursor:pointer; font-size:0.65rem; margin-left:4px; padding:2px; display:inline-flex; align-items:center; justify-content:center; line-height:1;';
        removePinBtn.title = 'Hapus input ini';
        removePinBtn.onclick = (e) => {
          e.stopPropagation();
          _connections = _connections.filter(c => !(c.toNodeId === node.id && c.toPinName === pin.name));
          node.properties.input_pins = (node.properties.input_pins || []).filter(name => name !== pin.name);
          saveCanvas();
          refreshNodeDOM(node);
        };
        row.appendChild(removePinBtn);
      }

      inCol.appendChild(row);
    });

    if (node.type === 'overlap_comparator' || node.type === 'ai_decision') {
      const addRow = document.createElement('div');
      addRow.className = 'pin-row';
      addRow.style.cssText = 'padding: 2px 4px;';
      
      const addBtn = document.createElement('button');
      addBtn.textContent = '+ Add Input';
      addBtn.className = 'btn btn-secondary';
      addBtn.style.cssText = 'font-size: 0.65rem; padding: 2px 6px; line-height: 1; border-radius: 4px; margin-left: 18px; margin-top: 2px;';
      addBtn.onclick = (e) => {
        e.stopPropagation();
        const currentPins = node.properties.input_pins || ['image', 'class', 'annotation1', 'annotation2'];
        let maxNum = 0;
        currentPins.forEach(p => {
          if (p.startsWith('annotation')) {
            const num = parseInt(p.replace('annotation', ''));
            if (num > maxNum) maxNum = num;
          }
        });
        const nextNum = maxNum + 1;
        currentPins.push(`annotation${nextNum}`);
        node.properties.input_pins = currentPins;
        saveCanvas();
        refreshNodeDOM(node);
      };
      addRow.appendChild(addBtn);
      inCol.appendChild(addRow);
    }

    // Outputs Column (Right)
    const outCol = document.createElement('div');
    outCol.className = 'pins-column pins-column-out';
    outputs.forEach(pin => {
      const row = document.createElement('div');
      row.className = 'pin-row';

      const label = document.createElement('span');
      label.className = 'pin-label';
      label.textContent = pin.label;

      const pinEl = document.createElement('div');
      pinEl.className = 'pin pin-out';
      pinEl.dataset.nodeId = node.id;
      pinEl.dataset.pinName = pin.name;
      pinEl.dataset.pinType = 'out';
      pinEl.onmousedown = (e) => startConnectionDrag(e, node.id, pin.name, 'out');
      
      // Check if connected
      const isConnected = _connections.some(c => c.fromNodeId === node.id && c.fromPinName === pin.name);
      if (isConnected) pinEl.classList.add('connected');

      row.append(label, pinEl);
      outCol.appendChild(row);
    });

    container.append(inCol, outCol);
    return container;
  }

  async function updatePointerNodeImage(nodeId) {
    try {
      const r = await fetch(`/api/node-image/${nodeId}`);
      if (r.ok) {
        const data = await r.json();
        const node = _nodes.find(n => n.id === nodeId);
        if (node && data.image) {
          node.properties.last_preview = data.image;
          saveCanvas();
          refreshNodeDOM(node);
        }
      } else {
        console.error("Failed to load image for pointer node", nodeId);
      }
    } catch (err) {
      console.error("Error fetching pointer image", err);
    }
  }

  function refreshConnectedPointers(sourceNodeId) {
    const downstream = new Set();
    downstream.add(sourceNodeId);
    
    let added = true;
    while (added) {
      added = false;
      _connections.forEach(conn => {
        if (downstream.has(conn.fromNodeId) && !downstream.has(conn.toNodeId)) {
          downstream.add(conn.toNodeId);
          added = true;
        }
      });
    }

    downstream.forEach(id => {
      if (id === sourceNodeId) return;
      const node = _nodes.find(n => n.id === id);
      if (node && node.type === 'pointer') {
        updatePointerNodeImage(id);
      }
    });
  }

  function renderPointsOverlay(node) {
    const wrapper = document.getElementById(`pointer-wrapper-${node.id}`);
    if (!wrapper) return;

    // Clear existing dots
    wrapper.querySelectorAll('.pointer-dot').forEach(el => el.remove());

    const points = node.properties.points || [];
    points.forEach((pt, idx) => {
      const dot = document.createElement('div');
      dot.className = `pointer-dot ${pt.label === 1 ? 'positive' : 'negative'}`;
      dot.style.left = (pt.x * 100) + '%';
      dot.style.top = (pt.y * 100) + '%';
      dot.style.transform = 'translate(-50%, -50%)';
      dot.textContent = pt.label === 1 ? '+' : '-';
      
      dot.title = `Point #${idx + 1} (${pt.label === 1 ? 'Positive' : 'Negative'}) - Right-click to remove`;
      dot.style.pointerEvents = 'auto';
      dot.oncontextmenu = (e) => {
        e.preventDefault();
        e.stopPropagation();
        node.properties.points.splice(idx, 1);
        saveCanvas();
        renderPointsOverlay(node);
      };

      wrapper.appendChild(dot);
    });
  }

  // --- Rendering Nodes DOM ---
  function renderPreviewContent(nodeId, previewData) {
    const previewContainer = document.getElementById(`preview-container-${nodeId}`);
    if (!previewContainer) return;

    previewContainer.innerHTML = '';

    if (!previewData || (Array.isArray(previewData) && previewData.length === 0)) {
      const previewPlaceholder = document.createElement('span');
      previewPlaceholder.className = 'preview-placeholder';
      previewPlaceholder.textContent = 'No Ground Truth/Predicted Preview';
      previewContainer.appendChild(previewPlaceholder);
      return;
    }

    const items = Array.isArray(previewData) ? previewData : [previewData];

    items.forEach((item, idx) => {
      if (typeof item === 'object' && item !== null && Array.isArray(item.items)) {
        // Structured 2-Row rendering for Overlap Comparator conflict item cards with individual images
        const itemWrapper = document.createElement('div');
        itemWrapper.style.cssText = 'width: 100%; margin-bottom: 8px; display: flex; flex-direction: column; gap: 4px; border: 1px solid var(--border); border-radius: 6px; padding: 6px; background: rgba(10,15,26,0.5); box-sizing: border-box;';

        const label = document.createElement('span');
        label.style.cssText = `font-size: 0.68rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; padding: 2px 6px; border-radius: 4px; background: rgba(239, 68, 68, 0.15); color: #f87171; width: fit-content;`;
        label.textContent = item.label || `Overlap Conflict #${idx+1}`;
        itemWrapper.appendChild(label);

        // Row 1: Crop BBox Outlines for all items side-by-side
        const row1 = document.createElement('div');
        row1.style.cssText = 'display: flex; flex-direction: row; flex-wrap: nowrap; overflow-x: auto; gap: 0; background: #000; border-radius: 4px; border: 1px solid var(--border); width: 100%; box-sizing: border-box;';
        
        item.items.forEach((child, cIdx) => {
          if (child.bbox_crop) {
            const img = document.createElement('img');
            img.style.cssText = `height: 140px; width: auto; flex: 1 1 0px; min-width: 0; object-fit: contain; display: block; ${cIdx < item.items.length - 1 ? 'border-right: 2px solid #505050;' : ''}`;
            img.src = `data:image/jpeg;base64,${child.bbox_crop}`;
            img.title = `${child.pin_label}: ${child.class_name}`;
            img.draggable = false;
            row1.appendChild(img);
          }
        });

        // Green accent separator line
        const sepLine = document.createElement('div');
        sepLine.style.cssText = 'height: 4px; background: #32b478; width: 100%; margin: 2px 0; border-radius: 2px;';

        // Row 2: Crop Segment Masks for all items side-by-side
        const row2 = document.createElement('div');
        row2.style.cssText = 'display: flex; flex-direction: row; flex-wrap: nowrap; overflow-x: auto; gap: 0; background: #000; border-radius: 4px; border: 1px solid var(--border); width: 100%; box-sizing: border-box;';
        
        item.items.forEach((child, cIdx) => {
          if (child.seg_crop) {
            const img = document.createElement('img');
            img.style.cssText = `height: 140px; width: auto; flex: 1 1 0px; min-width: 0; object-fit: contain; display: block; ${cIdx < item.items.length - 1 ? 'border-right: 2px solid #505050;' : ''}`;
            img.src = `data:image/jpeg;base64,${child.seg_crop}`;
            img.title = `${child.pin_label}: ${child.class_name}`;
            img.draggable = false;
            row2.appendChild(img);
          }
        });

        itemWrapper.append(row1, sepLine, row2);
        previewContainer.appendChild(itemWrapper);
        return;
      }

      const b64 = (typeof item === 'object' && item !== null) ? item.image : item;
      const customLabel = (typeof item === 'object' && item !== null) ? item.label : null;

      const itemWrapper = document.createElement('div');
      itemWrapper.style.cssText = 'width: 100%; margin-bottom: 8px; display: flex; flex-direction: column; gap: 4px; border: 1px solid var(--border); border-radius: 6px; padding: 4px; background: rgba(255,255,255,0.02);';

      let labelBg = 'rgba(168, 85, 247, 0.15)';
      let labelColor = '#c084fc';

      const category = (typeof item === 'object' && item !== null) ? item.category : null;
      if (category === 'raw') {
        labelBg = 'rgba(59, 130, 246, 0.15)';
        labelColor = '#60a5fa';
      } else if (category === 'overlap') {
        labelBg = 'rgba(239, 68, 68, 0.15)';
        labelColor = '#f87171';
      } else if (category === 'not_overlap') {
        labelBg = 'rgba(234, 179, 8, 0.15)';
        labelColor = '#facc15';
      }

      let showLabel = true;
      const label = document.createElement('span');
      label.style.cssText = `font-size: 0.68rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; padding: 2px 6px; border-radius: 4px; background: ${labelBg}; color: ${labelColor}; width: fit-content;`;
      
      if (customLabel !== null && customLabel !== undefined) {
        if (customLabel === '') {
          showLabel = false;
        } else {
          label.textContent = customLabel;
        }
      } else if (items.length > 1) {
        label.textContent = idx === 0 ? '1. Overall Detection Segment' : `2. Detection #${idx} (BBox Crop | Segment Crop)`;
      } else {
        label.textContent = 'Preview Output';
      }
      if (showLabel) {
        itemWrapper.appendChild(label);
      }

      const img = document.createElement('img');
      img.className = 'preview-img';
      img.style.cssText = 'width: 100%; height: auto; max-height: none; display: block; border-radius: 4px;';
      img.src = `data:image/jpeg;base64,${b64}`;
      img.draggable = false;

      itemWrapper.appendChild(img);
      previewContainer.appendChild(itemWrapper);
    });
  }

  function runFlowFromInputNode(inputId) {
    const downstream = new Set();
    downstream.add(inputId);
    
    let added = true;
    while (added) {
      added = false;
      _connections.forEach(conn => {
        if (downstream.has(conn.fromNodeId) && !downstream.has(conn.toNodeId)) {
          downstream.add(conn.toNodeId);
          added = true;
        }
      });
    }

    const targets = Array.from(downstream).filter(id => {
      const node = _nodes.find(n => n.id === id);
      return node && (node.type === 'preview' || node.type === 'overlap_comparator' || node.type === 'pointer' || node.type === 'sam3' || node.type === 'yolo_detector' || node.type === 'save_annotation');
    });

    if (targets.length === 0) {
      showToast('Tidak ada node valid (Save Annotation/Preview/Pointer/Model) yang terhubung di bawah input ini!', 'warning');
      return;
    }

    window.runFlow(Array.from(downstream));
  }

  function renderNodeDOM(node) {
    const el = document.createElement('div');
    el.id = node.id;
    el.className = `node ${node.type}`;
    if (_selectedNodeId === node.id) el.classList.add('selected');
    el.style.left = node.x + 'px';
    el.style.top = node.y + 'px';
    el.onclick = () => selectNode(node.id);

    // ResizeObserver to automatically redraw wires when node bounds change (resizable)
    if (window.ResizeObserver) {
      const ro = new ResizeObserver(() => {
        renderConnections();
      });
      ro.observe(el);
    }

    // Node Header
    const header = document.createElement('div');
    header.className = 'node-header';
    header.onmousedown = (e) => startDragNode(e, node.id);

    const title = document.createElement('div');
    title.className = 'node-header-title';
    title.textContent = node.type.toUpperCase().replace('_', ' ');

    const rightControls = document.createElement('div');
    rightControls.style.cssText = 'display:flex; align-items:center; gap:6px;';

    if (node.type === 'single_image' || node.type === 'folder' || node.type === 'pointer' || node.type === 'save_annotation' || node.type === 'preview' || node.type === 'overlap_comparator') {
      const runBtn = document.createElement('button');
      runBtn.textContent = '▶ Run';
      runBtn.title = 'Jalankan flow dari input ini';
      runBtn.style.cssText = 'border: none; background: #10b981; color: white; padding: 2px 6px; border-radius: 4px; font-size: 0.65rem; font-weight: 700; cursor: pointer; transition: all 0.2s ease; display: inline-flex; align-items: center; justify-content: center; line-height: 1;';
      runBtn.onmouseover = () => { runBtn.style.background = '#059669'; };
      runBtn.onmouseout = () => { runBtn.style.background = '#10b981'; };
      runBtn.onmousedown = () => { runBtn.style.transform = 'scale(0.95)'; };
      runBtn.onmouseup = () => { runBtn.style.transform = 'scale(1)'; };
      runBtn.onclick = (e) => {
        e.stopPropagation();
        runFlowFromInputNode(node.id);
      };
      rightControls.appendChild(runBtn);
    }

    const closeBtn = document.createElement('button');
    closeBtn.className = 'node-close-btn';
    closeBtn.textContent = '✕';
    closeBtn.title = 'Hapus Node';
    closeBtn.onclick = (e) => { e.stopPropagation(); deleteNode(node.id); };

    rightControls.appendChild(closeBtn);
    header.append(title, rightControls);

    // Node Body
    const body = document.createElement('div');
    body.className = 'node-body';

    // Configure Pins, Inputs, Outputs based on Type
    if (node.type === 'single_image') {
      const pins = createPinsLayout(node, [], [
        { name: 'image', label: 'Image' },
        { name: 'annotation', label: 'Annotation' },
        { name: 'class', label: 'Class' }
      ]);
      body.append(
        pins,
        createInputField('Image Path', 'text', node.properties.image_path, (v) => {
          node.properties.image_path = v;
          saveCanvas();
          refreshConnectedPointers(node.id);
        }),
        createInputField('Annotation Path (.txt)', 'text', node.properties.annotation_path, (v) => {
          node.properties.annotation_path = v;
          saveCanvas();
        })
      );

      // Drag and Drop support
      body.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.stopPropagation();
        el.classList.add('drag-over');
      });
      body.addEventListener('dragleave', (e) => {
        e.preventDefault();
        e.stopPropagation();
        el.classList.remove('drag-over');
      });
      body.addEventListener('drop', (e) => {
        e.preventDefault();
        e.stopPropagation();
        el.classList.remove('drag-over');
        if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
          uploadFileAndUpdateNode(e.dataTransfer.files[0], node.id);
        }
      });

      // Classes editor
      const classGroup = document.createElement('div');
      classGroup.className = 'field-group';
      classGroup.innerHTML = `
        <span class="field-label">Classes & Colors</span>
        <div class="class-list-container" id="class-list-${node.id}"></div>
      `;
      const addBtn = document.createElement('button');
      addBtn.className = 'btn-add-class';
      addBtn.textContent = '+ Add Class';
      addBtn.onclick = () => {
        node.properties.classes.push({ name: `class_${node.properties.classes.length}`, color: '#a855f7' });
        renderClassesList(node);
        saveCanvas();
        refreshAllYoloBindings();
      };
      classGroup.append(addBtn);
      body.append(classGroup);
      setTimeout(() => renderClassesList(node), 0);

    } else if (node.type === 'folder') {
      const pins = createPinsLayout(node, [], [
        { name: 'image', label: 'Image' },
        { name: 'annotation', label: 'Annotation' },
        { name: 'class', label: 'Class' }
      ]);
      body.append(
        pins,
        createInputField('Images Folder', 'text', node.properties.images_dir, (v) => {
          node.properties.images_dir = v;
          saveCanvas();
          refreshConnectedPointers(node.id);
        }),
        createInputField('Labels Folder', 'text', node.properties.labels_dir, (v) => {
          node.properties.labels_dir = v;
          saveCanvas();
        })
      );

      // Classes editor
      const classGroup = document.createElement('div');
      classGroup.className = 'field-group';
      classGroup.innerHTML = `
        <span class="field-label">Classes & Colors</span>
        <div class="class-list-container" id="class-list-${node.id}"></div>
      `;
      const addBtn = document.createElement('button');
      addBtn.className = 'btn-add-class';
      addBtn.textContent = '+ Add Class';
      addBtn.onclick = () => {
        node.properties.classes.push({ name: `class_${node.properties.classes.length}`, color: '#a855f7' });
        renderClassesList(node);
        saveCanvas();
        refreshAllYoloBindings();
      };
      classGroup.append(addBtn);
      body.append(classGroup);
      setTimeout(() => renderClassesList(node), 0);

    } else if (node.type === 'yolo_detector') {
      const pins = createPinsLayout(node, 
        [
          { name: 'image', label: 'Image' },
          { name: 'class', label: 'Class' }
        ],
        [
          { name: 'image', label: 'Image' },
          { name: 'annotation', label: 'Annotation' },
          { name: 'class', label: 'Class' }
        ]
      );
      body.appendChild(pins);

      // 1. Model Selection
      const modelGroup = document.createElement('div');
      modelGroup.className = 'field-group';
      modelGroup.innerHTML = `<span class="field-label">YOLO Model</span>`;
      const modelSel = document.createElement('select');
      modelSel.className = 'field-input';
      const yoloModels = _cachedModels.filter(m => !m.toLowerCase().includes('sam'));
      if (!yoloModels.includes('platLarge.pt')) {
        yoloModels.unshift('platLarge.pt');
      }
      if (!node.properties.model || node.properties.model === 'yolov8x-seg.pt') {
        node.properties.model = 'platLarge.pt';
      }
      yoloModels.forEach(m => {
        const o = document.createElement('option');
        o.value = m; o.textContent = m;
        if (m === node.properties.model) o.selected = true;
        modelSel.appendChild(o);
      });
      modelSel.onchange = () => {
        node.properties.model = modelSel.value;
        saveCanvas();
        refreshYoloBindings(node.id);
      };
      modelGroup.appendChild(modelSel);

      // 2. Imgsz input
      const imgszRow = createInputField('Image Size (imgsz)', 'number', node.properties.imgsz, (v) => {
        node.properties.imgsz = parseInt(v) || 640;
        saveCanvas();
      });

      // 3. Conf slider
      const confGroup = document.createElement('div');
      confGroup.className = 'field-group';
      confGroup.innerHTML = `
        <div style="display:flex; justify-content:space-between;">
          <span class="field-label">Confidence</span>
          <span id="conf-val-${node.id}" style="font-size:0.75rem; color:var(--accent); font-weight:600;">${Math.round(node.properties.conf*100)}%</span>
        </div>
        <input type="range" min="1" max="99" value="${Math.round(node.properties.conf*100)}" style="accent-color:var(--accent); cursor:pointer;" />
      `;
      const confSlider = confGroup.querySelector('input');
      confSlider.oninput = () => {
        document.getElementById(`conf-val-${node.id}`).textContent = confSlider.value + '%';
        node.properties.conf = parseFloat(confSlider.value) / 100;
        saveCanvas();
      };

      // 4. Verbose checkbox
      const verboseRow = document.createElement('div');
      verboseRow.style.cssText = 'display:flex; align-items:center; gap:8px;';
      const verboseChk = document.createElement('input');
      verboseChk.type = 'checkbox';
      verboseChk.checked = !!node.properties.verbose;
      verboseChk.onchange = () => {
        node.properties.verbose = verboseChk.checked;
        saveCanvas();
      };
      const verboseLbl = document.createElement('span');
      verboseLbl.className = 'field-label';
      verboseLbl.textContent = 'Verbose (Show logs)';
      verboseRow.append(verboseChk, verboseLbl);

      // 5. GPU device
      const gpuGroup = document.createElement('div');
      gpuGroup.className = 'field-group';
      gpuGroup.innerHTML = `<span class="field-label">Device</span>`;
      const gpuSel = document.createElement('select');
      gpuSel.className = 'field-input';
      _cachedGpus.forEach(g => {
        const o = document.createElement('option');
        o.value = g.id; o.textContent = g.name;
        if (g.id === node.properties.device) o.selected = true;
        gpuSel.appendChild(o);
      });
      gpuSel.onchange = () => {
        node.properties.device = gpuSel.value;
        saveCanvas();
      };
      gpuGroup.appendChild(gpuSel);

      // 6. Bindings configuration container
      const bindingGroup = document.createElement('div');
      bindingGroup.className = 'field-group';
      bindingGroup.innerHTML = `
        <span class="field-label">Class Bindings</span>
        <div class="binding-list-container" id="binding-list-${node.id}">
          <span style="font-size:0.72rem; color:var(--text-muted);">Connect Input Class to configure bindings</span>
        </div>
      `;

      // 7. Resizable Preview frame
      const previewContainer = document.createElement('div');
      previewContainer.className = 'preview-container resizable-box';
      previewContainer.id = `preview-container-${node.id}`;
      if (node.properties.preview_width) {
        previewContainer.style.width = node.properties.preview_width + 'px';
        previewContainer.style.height = node.properties.preview_height + 'px';
      }
      previewContainer.onmouseup = () => {
        node.properties.preview_width = previewContainer.clientWidth;
        node.properties.preview_height = previewContainer.clientHeight;
        saveCanvas();
      };
      
      const previewPlaceholder = document.createElement('span');
      previewPlaceholder.className = 'preview-placeholder';
      previewPlaceholder.textContent = 'No Detection Preview';
      
      const previewImg = document.createElement('img');
      previewImg.className = 'preview-img';
      previewImg.id = `preview-img-${node.id}`;
      previewImg.style.display = 'none';
      previewImg.draggable = false;
      if (node.properties.last_preview) {
        previewImg.src = `data:image/jpeg;base64,${node.properties.last_preview}`;
        previewImg.style.display = 'block';
        previewPlaceholder.style.display = 'none';
      }
      
      previewContainer.append(previewPlaceholder, previewImg);

      // 8. Logs / Console container
      const logsGroup = document.createElement('div');
      logsGroup.className = 'field-group';
      logsGroup.innerHTML = `
        <span class="field-label">YOLO Logs & Detections</span>
        <div class="yolo-logs-container" id="yolo-logs-${node.id}">
          <span style="color:var(--text-muted);">No logs available. Run flow to see output.</span>
        </div>
      `;
      const logsConsole = logsGroup.querySelector('.yolo-logs-container');
      if (node.properties.last_logs) {
        logsConsole.innerHTML = node.properties.last_logs;
      }

      body.append(modelGroup, imgszRow, confGroup, verboseRow, gpuGroup, bindingGroup, previewContainer, logsGroup);
      setTimeout(() => refreshYoloBindings(node.id), 0);

    } else if (node.type === 'sam3') {
      const pins = createPinsLayout(node, 
        [
          { name: 'image', label: 'Image' },
          { name: 'class', label: 'Class' },
          { name: 'point', label: 'Point', optional: true }
        ],
        [
          { name: 'image', label: 'Image' },
          { name: 'annotation', label: 'Annotation' },
          { name: 'class', label: 'Class' }
        ]
      );
      body.appendChild(pins);

      // 1. Model Selection (filtered to models containing 'sam')
      const modelGroup = document.createElement('div');
      modelGroup.className = 'field-group';
      modelGroup.innerHTML = `<span class="field-label">SAM3 Model</span>`;
      const modelSel = document.createElement('select');
      modelSel.className = 'field-input';
      
      const samModels = _cachedModels.filter(m => m.toLowerCase().includes('sam'));
      if (samModels.length === 0) {
        samModels.push('sam3.pt');
        samModels.push('sam3.1.pt');
      }
      samModels.forEach(m => {
        const o = document.createElement('option');
        o.value = m; o.textContent = m;
        if (m === node.properties.model) o.selected = true;
        modelSel.appendChild(o);
      });
      modelSel.onchange = () => {
        node.properties.model = modelSel.value;
        saveCanvas();
        refreshSam3Bindings(node.id);
      };
      modelGroup.appendChild(modelSel);

      // 2. Imgsz input
      const imgszRow = createInputField('Image Size (imgsz)', 'number', node.properties.imgsz, (v) => {
        node.properties.imgsz = parseInt(v) || 640;
        saveCanvas();
      });

      // 3. Conf slider
      const confGroup = document.createElement('div');
      confGroup.className = 'field-group';
      confGroup.innerHTML = `
        <div style="display:flex; justify-content:space-between;">
          <span class="field-label">Confidence</span>
          <span id="conf-val-${node.id}" style="font-size:0.75rem; color:var(--accent); font-weight:600;">${Math.round(node.properties.conf*100)}%</span>
        </div>
        <input type="range" min="1" max="99" value="${Math.round(node.properties.conf*100)}" style="accent-color:var(--accent); cursor:pointer;" />
      `;
      const confSlider = confGroup.querySelector('input');
      confSlider.oninput = () => {
        document.getElementById(`conf-val-${node.id}`).textContent = confSlider.value + '%';
        node.properties.conf = parseFloat(confSlider.value) / 100;
        saveCanvas();
      };

      // 4. Verbose checkbox
      const verboseRow = document.createElement('div');
      verboseRow.style.cssText = 'display:flex; align-items:center; gap:8px;';
      const verboseChk = document.createElement('input');
      verboseChk.type = 'checkbox';
      verboseChk.checked = !!node.properties.verbose;
      verboseChk.onchange = () => {
        node.properties.verbose = verboseChk.checked;
        saveCanvas();
      };
      const verboseLbl = document.createElement('span');
      verboseLbl.className = 'field-label';
      verboseLbl.textContent = 'Verbose (Show logs)';
      verboseRow.append(verboseChk, verboseLbl);

      // 5. GPU device
      const gpuGroup = document.createElement('div');
      gpuGroup.className = 'field-group';
      gpuGroup.innerHTML = `<span class="field-label">Device</span>`;
      const gpuSel = document.createElement('select');
      gpuSel.className = 'field-input';
      _cachedGpus.forEach(g => {
        const o = document.createElement('option');
        o.value = g.id; o.textContent = g.name;
        if (g.id === node.properties.device) o.selected = true;
        gpuSel.appendChild(o);
      });
      gpuSel.onchange = () => {
        node.properties.device = gpuSel.value;
        saveCanvas();
      };
      gpuGroup.appendChild(gpuSel);

      // 6. Bindings configuration container
      const bindingGroup = document.createElement('div');
      bindingGroup.className = 'field-group';
      bindingGroup.innerHTML = `
        <span class="field-label">Prompt Bindings</span>
        <div class="binding-list-container" id="binding-list-${node.id}">
          <span style="font-size:0.72rem; color:var(--text-muted);">Connect Input Class to configure prompt bindings</span>
        </div>
      `;

      // 7. Resizable Preview frame
      const previewContainer = document.createElement('div');
      previewContainer.className = 'preview-container resizable-box';
      previewContainer.id = `preview-container-${node.id}`;
      if (node.properties.preview_width) {
        previewContainer.style.width = node.properties.preview_width + 'px';
        previewContainer.style.height = node.properties.preview_height + 'px';
      }
      previewContainer.onmouseup = () => {
        node.properties.preview_width = previewContainer.clientWidth;
        node.properties.preview_height = previewContainer.clientHeight;
        saveCanvas();
      };
      
      const previewPlaceholder = document.createElement('span');
      previewPlaceholder.className = 'preview-placeholder';
      previewPlaceholder.textContent = 'No Detection Preview';
      
      const previewImg = document.createElement('img');
      previewImg.className = 'preview-img';
      previewImg.id = `preview-img-${node.id}`;
      previewImg.style.display = 'none';
      previewImg.draggable = false;
      if (node.properties.last_preview) {
        previewImg.src = `data:image/jpeg;base64,${node.properties.last_preview}`;
        previewImg.style.display = 'block';
        previewPlaceholder.style.display = 'none';
      }
      
      previewContainer.append(previewPlaceholder, previewImg);

      // 8. Logs / Console container
      const logsGroup = document.createElement('div');
      logsGroup.className = 'field-group';
      logsGroup.innerHTML = `
        <span class="field-label">SAM3 Logs & Detections</span>
        <div class="yolo-logs-container" id="yolo-logs-${node.id}">
          <span style="color:var(--text-muted);">No logs available. Run flow to see output.</span>
        </div>
      `;
      const logsConsole = logsGroup.querySelector('.yolo-logs-container');
      if (node.properties.last_logs) {
        logsConsole.innerHTML = node.properties.last_logs;
      }

      body.append(modelGroup, imgszRow, confGroup, verboseRow, gpuGroup, bindingGroup, previewContainer, logsGroup);
      setTimeout(() => refreshSam3Bindings(node.id), 0);

    } else if (node.type === 'preview') {
      const pins = createPinsLayout(node, 
        [
          { name: 'image', label: 'Image' },
          { name: 'annotation', label: 'Annotation' },
          { name: 'class', label: 'Class', optional: true }
        ],
        []
      );
      body.appendChild(pins);

      // Resizable Preview frame
      const previewContainer = document.createElement('div');
      previewContainer.className = 'preview-container resizable-box';
      previewContainer.id = `preview-container-${node.id}`;
      previewContainer.style.cssText = 'overflow-y: auto; display: flex; flex-direction: column; gap: 4px; padding: 6px; align-items: stretch; justify-content: flex-start;';
      if (node.properties.preview_width) {
        previewContainer.style.width = node.properties.preview_width + 'px';
        previewContainer.style.height = node.properties.preview_height + 'px';
      }
      previewContainer.onmouseup = () => {
        node.properties.preview_width = previewContainer.clientWidth;
        node.properties.preview_height = previewContainer.clientHeight;
        saveCanvas();
      };
      
      body.appendChild(previewContainer);
      setTimeout(() => renderPreviewContent(node.id, node.properties.last_preview), 0);
    } else if (node.type === 'overlap_comparator') {
      const inputPins = node.properties.input_pins || ['image', 'class', 'annotation1', 'annotation2'];
      if (!inputPins.includes('class')) {
        const idx = inputPins.indexOf('image');
        inputPins.splice(idx !== -1 ? idx + 1 : 1, 0, 'class');
        node.properties.input_pins = inputPins;
      }
      const pins_in = inputPins.map(name => {
        let label = name === 'image' ? 'Image' : (name === 'class' ? 'Class' : `Annotation ${name.replace('annotation', '')}`);
        let optional = name === 'class';
        return { name, label, optional };
      });
      const pins_out = [
        { name: 'image', label: 'Image' },
        { name: 'processed_annotation', label: 'Processed Annotation' }
      ];
      const pins = createPinsLayout(node, pins_in, pins_out);
      body.appendChild(pins);

      // Comparator Action Section (below input pins, above IoU threshold)
      const actionGroup = document.createElement('div');
      actionGroup.className = 'field-group';
      actionGroup.style.cssText = 'margin-top:4px; margin-bottom:8px; border:1px solid var(--border); border-radius:6px; padding:8px; background:rgba(255,255,255,0.02);';
      
      const actionHeader = document.createElement('div');
      actionHeader.style.cssText = 'display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;';
      actionHeader.innerHTML = `
        <span class="field-label" style="margin:0; font-size:0.7rem; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.05em;">Comparator Action</span>
      `;
      actionGroup.appendChild(actionHeader);

      const rulesContainer = document.createElement('div');
      rulesContainer.id = `comparator-rules-list-${node.id}`;
      rulesContainer.style.cssText = 'display:flex; flex-direction:column; gap:4px; margin-bottom:8px; max-height:100px; overflow-y:auto;';
      actionGroup.appendChild(rulesContainer);

      const renderComparatorRules = () => {
        rulesContainer.innerHTML = '';
        const rules = node.properties.comparator_rules || [];
        if (rules.length === 0) {
          const hint = document.createElement('div');
          hint.style.cssText = 'font-size:0.7rem; color:var(--text-muted); text-align:center; padding:2px; font-style:italic;';
          hint.textContent = 'Default aksi pasang terdeteksi: Compare';
          rulesContainer.appendChild(hint);
        } else {
          rules.forEach((rule, rIdx) => {
            const rRow = document.createElement('div');
            rRow.style.cssText = 'display:flex; justify-content:space-between; align-items:center; background:rgba(0,0,0,0.2); border:1px solid var(--border); padding:3px 6px; border-radius:4px; font-size:0.72rem;';
            
            let actTxt = 'Compare';
            if (rule.action === 'choose_src') actTxt = `Choose ${rule.src}`;
            else if (rule.action === 'choose_target') actTxt = `Choose ${rule.target}`;
            else if (rule.action === 'choose_annotation1') actTxt = `Choose ${rule.src}`;
            else if (rule.action === 'choose_annotation2') actTxt = `Choose ${rule.target}`;

            const rLabel = document.createElement('span');
            rLabel.style.cssText = 'color:var(--text-primary); font-weight:500; text-overflow:ellipsis; overflow:hidden; white-space:nowrap; margin-right:4px;';
            rLabel.textContent = `${rule.src} ↔ ${rule.target} ➔ ${actTxt}`;

            const rDelBtn = document.createElement('button');
            rDelBtn.className = 'node-close-btn';
            rDelBtn.textContent = '×';
            rDelBtn.style.cssText = 'font-size:0.9rem; padding:0 3px; color:#ef4444; background:none; border:none; cursor:pointer;';
            rDelBtn.onclick = () => {
              node.properties.comparator_rules.splice(rIdx, 1);
              saveCanvas();
              renderComparatorRules();
            };

            rRow.append(rLabel, rDelBtn);
            rulesContainer.appendChild(rRow);
          });
        }
      };

      // Add Rule Form
      const addRuleForm = document.createElement('div');
      addRuleForm.style.cssText = 'display:flex; flex-direction:column; gap:4px;';
      
      const selectsRow = document.createElement('div');
      selectsRow.style.cssText = 'display:flex; gap:4px; align-items:center;';

      const annoPinsOnly = inputPins.filter(p => p.startsWith('annotation'));

      const srcSel = document.createElement('select');
      srcSel.className = 'binding-select';
      srcSel.style.cssText = 'flex:1; font-size:0.7rem; padding:2px; min-width:0;';
      
      const targetSel = document.createElement('select');
      targetSel.className = 'binding-select';
      targetSel.style.cssText = 'flex:1; font-size:0.7rem; padding:2px; min-width:0;';

      const actionSel = document.createElement('select');
      actionSel.className = 'binding-select';
      actionSel.style.cssText = 'flex:1.2; font-size:0.7rem; padding:2px; min-width:0;';

      const updateSelectOptions = () => {
        srcSel.innerHTML = '';
        targetSel.innerHTML = '';
        annoPinsOnly.forEach(p => {
          const opt1 = document.createElement('option');
          opt1.value = p; opt1.textContent = p;
          srcSel.appendChild(opt1);

          const opt2 = document.createElement('option');
          opt2.value = p; opt2.textContent = p;
          targetSel.appendChild(opt2);
        });
        if (targetSel.options.length > 1) {
          targetSel.selectedIndex = 1;
        }
        updateActionOptions();
      };

      const updateActionOptions = () => {
        actionSel.innerHTML = '';
        const sVal = srcSel.value || 'Input 1';
        const tVal = targetSel.value || 'Input 2';

        const o1 = document.createElement('option');
        o1.value = 'choose_src'; o1.textContent = `Choose ${sVal}`;
        
        const o2 = document.createElement('option');
        o2.value = 'choose_target'; o2.textContent = `Choose ${tVal}`;

        const o3 = document.createElement('option');
        o3.value = 'compare'; o3.textContent = 'Compare';

        actionSel.append(o1, o2, o3);
      };

      srcSel.onchange = updateActionOptions;
      targetSel.onchange = updateActionOptions;
      updateSelectOptions();

      const addRuleBtn = document.createElement('button');
      addRuleBtn.className = 'btn';
      addRuleBtn.style.cssText = 'padding:3px 8px; font-size:0.7rem; background:var(--accent); margin-top:2px; width:100%;';
      addRuleBtn.textContent = '+ Add Action Rule';
      addRuleBtn.onclick = (e) => {
        e.preventDefault();
        const sVal = srcSel.value;
        const tVal = targetSel.value;
        const aVal = actionSel.value;
        if (!sVal || !tVal) return;
        if (sVal === tVal) {
          showToast('Source dan target annotation harus berbeda.', 'error');
          return;
        }
        if (!node.properties.comparator_rules) node.properties.comparator_rules = [];
        
        node.properties.comparator_rules = node.properties.comparator_rules.filter(r => 
          !( (r.src === sVal && r.target === tVal) || (r.src === tVal && r.target === sVal) )
        );

        node.properties.comparator_rules.push({ src: sVal, target: tVal, action: aVal });
        saveCanvas();
        renderComparatorRules();
      };

      selectsRow.append(srcSel, targetSel);
      addRuleForm.append(selectsRow, actionSel, addRuleBtn);
      actionGroup.appendChild(addRuleForm);

      body.appendChild(actionGroup);
      setTimeout(renderComparatorRules, 0);

      // IoU Threshold Slider
      const iouGroup = document.createElement('div');
      iouGroup.className = 'field-group';
      iouGroup.innerHTML = `
        <div style="display:flex; justify-content:space-between;">
          <span class="field-label">IoU Threshold</span>
          <span id="iou-val-${node.id}" style="font-size:0.75rem; color:var(--accent); font-weight:600;">${Math.round(node.properties.iou_threshold*100)}%</span>
        </div>
        <input type="range" min="0" max="100" value="${Math.round(node.properties.iou_threshold*100)}" style="accent-color:var(--accent); cursor:pointer;" />
      `;
      const iouSlider = iouGroup.querySelector('input');
      iouSlider.oninput = () => {
        document.getElementById(`iou-val-${node.id}`).textContent = iouSlider.value + '%';
        node.properties.iou_threshold = parseFloat(iouSlider.value) / 100;
        saveCanvas();
      };
      body.appendChild(iouGroup);



      // Resizable Preview frame
      const previewContainer = document.createElement('div');
      previewContainer.className = 'preview-container resizable-box';
      previewContainer.id = `preview-container-${node.id}`;
      previewContainer.style.cssText = 'overflow-y: auto; display: flex; flex-direction: column; gap: 4px; padding: 6px; align-items: stretch; justify-content: flex-start;';
      if (node.properties.preview_width) {
        previewContainer.style.width = node.properties.preview_width + 'px';
        previewContainer.style.height = node.properties.preview_height + 'px';
      }
      previewContainer.onmouseup = () => {
        node.properties.preview_width = previewContainer.clientWidth;
        node.properties.preview_height = previewContainer.clientHeight;
        saveCanvas();
      };
      body.appendChild(previewContainer);
      setTimeout(() => renderPreviewContent(node.id, node.properties.last_preview), 0);
    } else if (node.type === 'ai_decision') {
      const inputPins = node.properties.input_pins || ['image', 'class', 'annotation1', 'annotation2'];
      if (!inputPins.includes('class')) {
        const idx = inputPins.indexOf('image');
        inputPins.splice(idx !== -1 ? idx + 1 : 1, 0, 'class');
        node.properties.input_pins = inputPins;
      }
      const pins_in = inputPins.map(name => {
        let label = name === 'image' ? 'Image' : (name === 'class' ? 'Class' : `Annotation ${name.replace('annotation', '')}`);
        let optional = name === 'class';
        return { name, label, optional };
      });
      const pins = createPinsLayout(node, pins_in, []);
      body.appendChild(pins);

      // Model selector with settings gear button
      const modelGroup = document.createElement('div');
      modelGroup.className = 'field-group';
      modelGroup.innerHTML = `
        <span class="field-label">AI Model</span>
        <div style="display:flex; gap:6px; align-items:center;">
          <select id="model-select-${node.id}" class="field-input" style="flex:1; width:0; min-width:0;"></select>
          <button id="settings-btn-${node.id}" class="ai-decision-settings-btn" title="Model Settings">
            <svg viewBox="0 0 24 24" style="width:16px;height:16px;fill:currentColor">
              <path d="M12,15.5A3.5,3.5 0 0,1 8.5,12A3.5,3.5 0 0,1 12,8.5A3.5,3.5 0 0,1 15.5,12A3.5,3.5 0 0,1 12,15.5M19.43,12.97C19.47,12.65 19.5,12.33 19.5,12C19.5,11.67 19.47,11.34 19.43,11L21.54,9.37C21.73,9.22 21.78,8.95 21.66,8.73L19.66,5.27C19.54,5.05 19.27,4.96 19.05,5.05L16.56,6.05C16.04,5.66 15.47,5.34 14.86,5.08L14.47,2.42C14.43,2.18 14.22,2 13.97,2H9.97C9.72,2 9.51,2.18 9.47,2.42L9.08,5.08C8.47,5.34 7.9,5.66 7.38,6.05L4.89,5.05C4.67,4.96 4.4,5.05 4.27,5.27L2.27,8.73C2.15,8.95 2.2,9.22 2.4,9.37L4.5,11C4.47,11.34 4.45,11.67 4.45,12C4.45,12.33 4.47,12.65 4.5,13L2.4,14.63C2.2,14.78 2.15,15.05 2.27,15.27L4.27,18.73C4.40,18.95 4.67,19.04 4.89,18.95L7.38,17.95C7.9,18.34 8.47,18.66 9.08,18.92L9.47,21.58C9.51,21.82 9.72,22 9.97,22H13.97C14.22,22 14.43,21.82 14.47,21.58L14.86,18.92C15.47,18.66 16.04,18.34 16.56,17.95L19.05,18.95C19.27,19.04 19.54,18.95 19.66,18.73L21.66,15.27C21.78,15.05 21.73,14.78 21.54,14.63L19.43,12.97Z"/>
            </svg>
          </button>
        </div>
      `;
      const selectEl = modelGroup.querySelector('select');
      const settingsBtn = modelGroup.querySelector('button');

      const populateModels = () => {
        selectEl.innerHTML = '';
        _aiModels.forEach(m => {
          const opt = document.createElement('option');
          opt.value = m;
          opt.textContent = m;
          if (m === node.properties.model) opt.selected = true;
          selectEl.appendChild(opt);
        });
      };
      populateModels();

      selectEl.onchange = () => {
        node.properties.model = selectEl.value;
        saveCanvas();
      };
      
      settingsBtn.onclick = () => {
        showModelSettingsModal(node, populateModels);
      };
      body.appendChild(modelGroup);

      // Class Rules container (exactly like SAM3 prompt bindings)
      const rulesGroup = document.createElement('div');
      rulesGroup.className = 'field-group';
      rulesGroup.innerHTML = `
        <span class="field-label">Class Rules Bindings</span>
        <div style="font-size:0.68rem; color:var(--text-muted); margin:3px 0 6px 0; line-height:1.4;">
          Tag placeholder yang tersedia:<br/>
          <code style="color:#34d399; background:rgba(255,255,255,0.06); padding:1px 4px; border-radius:3px;">&#123;class_rules&#125;</code>: Daftar aturan kelas binding<br/>
          <code style="color:#38bdf8; background:rgba(255,255,255,0.06); padding:1px 4px; border-radius:3px;">&#123;class&#125;</code>: Daftar kelas yang tersedia (Available Classes)
        </div>
        <div id="rules-list-${node.id}" style="display:flex; flex-direction:column; gap:6px; margin-top:4px;"></div>
        <div id="class-list-container-${node.id}" style="margin-top:10px; border-top:1px solid rgba(255,255,255,0.06); padding-top:8px;"></div>
      `;
      body.appendChild(rulesGroup);

      // Global Rules textarea
      const globalGroup = document.createElement('div');
      globalGroup.className = 'field-group';
      globalGroup.innerHTML = `
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
          <span class="field-label" style="margin:0;">Global Rules / Context</span>
          <button id="global-save-${node.id}" class="btn" style="display:none; padding:2px 8px; font-size:0.68rem; background:var(--accent); line-height:1; border-radius:4px; gap:4px; align-items:center; height:18px;">
            💾 Save
          </button>
        </div>
        <textarea class="field-input" style="width:100%; min-height:80px; font-family:inherit; resize:vertical; background:var(--bg-primary); border:1px solid var(--border); border-radius:6px; color:var(--text-primary); font-size:0.78rem; padding:6px 10px; box-sizing:border-box; outline:none; transition:border-color 0.15s;" placeholder="Masukkan aturan global atau sertakan placeholder {class_rules}, {class}, atau {image_input}..."></textarea>
        
        <div style="font-size:0.68rem; color:var(--text-muted); margin-top:5px; line-height:1.4;">
          Tag placeholder pasangan konflik IoU:<br/>
          <code style="color:#fbbf24; background:rgba(255,255,255,0.06); padding:1px 4px; border-radius:3px;">&#123;image_input&#125;</code>: Berisi info pasangan anotasi<br/>
          <span style="color:var(--text-secondary); font-family:monospace;">image&#123;index&#125;:&#123;annotation class&#125;</span><br/>
          <i>Contoh data konflik:</i><br/>
          <span style="color:#94a3b8; font-family:monospace;">image 1: car<br/>image 2: truck<br/>image 3: truck</span><br/>
          <span style="color:var(--text-muted); font-size:0.65rem;">(Jika tag placeholder diisi dalam global rules di atas, info tambahan tersebut akan dikirim ke AI)</span>
        </div>

        <div style="margin-top:8px;">
          <button id="preview-toggle-${node.id}" class="btn btn-secondary" style="font-size:0.72rem; padding:4px 8px; width:100%; display:flex; align-items:center; justify-content:center; gap:6px;">
            👁️ Show Preview
          </button>
          <div id="ai-prompt-preview-${node.id}" style="display:none; margin-top:8px; background:#060911; border:1px solid var(--border); border-radius:6px; padding:8px 10px; font-family:'JetBrains Mono', Consolas, monospace; font-size:0.7rem; color:#e2e8f0; max-height:220px; overflow-y:auto; white-space:pre-wrap; word-break:break-word;"></div>
        </div>
      `;
      // Restore node width if saved
      if (node.properties.node_width) {
        el.style.width = node.properties.node_width + 'px';
      }
      el.onmouseup = () => {
        if (el.clientWidth) {
          node.properties.node_width = el.clientWidth;
          saveCanvas();
        }
      };

      const txtArea = globalGroup.querySelector('textarea');
      const globalSaveBtn = globalGroup.querySelector(`#global-save-${node.id}`);
      const toggleBtn = globalGroup.querySelector(`#preview-toggle-${node.id}`);
      const previewBox = globalGroup.querySelector(`#ai-prompt-preview-${node.id}`);
      
      if (node.properties.global_rules_height) {
        txtArea.style.height = node.properties.global_rules_height + 'px';
      }
      txtArea.onmouseup = () => {
        if (txtArea.clientHeight) {
          node.properties.global_rules_height = txtArea.clientHeight;
          saveCanvas();
        }
      };

      previewBox.style.resize = 'vertical';
      if (node.properties.prompt_preview_height) {
        previewBox.style.height = node.properties.prompt_preview_height + 'px';
        previewBox.style.maxHeight = 'none';
      }
      previewBox.onmouseup = () => {
        if (previewBox.clientHeight) {
          node.properties.prompt_preview_height = previewBox.clientHeight;
          saveCanvas();
        }
      };

      txtArea.value = node.properties.global_rules || '';
      txtArea.oninput = () => {
        globalSaveBtn.style.display = 'inline-flex';
        if (previewBox.style.display !== 'none') {
          updateAiPromptPreview(node.id);
        }
      };
      
      globalSaveBtn.onclick = (e) => {
        e.preventDefault();
        node.properties.global_rules = txtArea.value;
        saveCanvas();
        globalSaveBtn.style.display = 'none';
        showToast('Global rules saved!', 'success');
        if (previewBox.style.display !== 'none') {
          updateAiPromptPreview(node.id);
        }
      };

      toggleBtn.onclick = (e) => {
        e.preventDefault();
        const isHidden = previewBox.style.display === 'none';
        if (isHidden) {
          updateAiPromptPreview(node.id);
          previewBox.style.display = 'block';
          toggleBtn.innerHTML = '👁️ Hide Preview';
        } else {
          previewBox.style.display = 'none';
          toggleBtn.innerHTML = '👁️ Show Preview';
        }
      };

      body.appendChild(globalGroup);

      // Resizable Preview frame
      const previewContainer = document.createElement('div');
      previewContainer.className = 'preview-container resizable-box';
      previewContainer.id = `preview-container-${node.id}`;
      previewContainer.style.cssText = 'overflow-y: auto; display: flex; flex-direction: column; gap: 4px; padding: 6px; align-items: stretch; justify-content: flex-start;';
      if (node.properties.preview_width) {
        previewContainer.style.width = node.properties.preview_width + 'px';
      }
      if (node.properties.preview_height) {
        previewContainer.style.height = node.properties.preview_height + 'px';
      }
      previewContainer.onmouseup = () => {
        node.properties.preview_width = previewContainer.clientWidth;
        node.properties.preview_height = previewContainer.clientHeight;
        saveCanvas();
      };
      
      const logsConsole = document.createElement('div');
      logsConsole.className = 'yolo-logs-console';
      logsConsole.id = `yolo-logs-${node.id}`;
      logsConsole.style.cssText = 'height:60px; font-family:monospace; font-size:0.7rem; background:#070a13; border:1px solid var(--border); border-radius:6px; padding:6px; color:#ef4444; overflow-y:auto; box-sizing:border-box; margin-top:4px; font-weight:normal; line-height:1.2; resize:vertical;';
      if (node.properties.logs_height) {
        logsConsole.style.height = node.properties.logs_height + 'px';
        logsConsole.style.maxHeight = 'none';
      }
      logsConsole.onmouseup = () => {
        if (logsConsole.clientHeight) {
          node.properties.logs_height = logsConsole.clientHeight;
          saveCanvas();
        }
      };
      logsConsole.innerHTML = node.properties.last_logs || '<div style="color:var(--text-muted);">No logs available. Run flow to see output.</div>';
      
      body.append(previewContainer, logsConsole);
      setTimeout(() => {
        renderPreviewContent(node.id, node.properties.last_preview);
        refreshAiDecisionRules(node.id);
      }, 0);
    } else if (node.type === 'pointer') {
      const pins = createPinsLayout(node, 
        [
          { name: 'image', label: 'Image' }
        ],
        [
          { name: 'image', label: 'Image' },
          { name: 'point', label: 'Point' }
        ]
      );
      body.appendChild(pins);

      // Render toolbar
      const toolbar = document.createElement('div');
      toolbar.className = 'pointer-toolbar';
      
      const btnPos = document.createElement('button');
      btnPos.className = `pointer-btn ${node.properties.active_mode === 'positive' ? 'active-pos' : ''}`;
      btnPos.innerHTML = '<span>➕</span> Pos';
      btnPos.onclick = () => {
        node.properties.active_mode = 'positive';
        saveCanvas();
        refreshNodeDOM(node);
      };

      const btnNeg = document.createElement('button');
      btnNeg.className = `pointer-btn ${node.properties.active_mode === 'negative' ? 'active-neg' : ''}`;
      btnNeg.innerHTML = '<span>➖</span> Neg';
      btnNeg.onclick = () => {
        node.properties.active_mode = 'negative';
        saveCanvas();
        refreshNodeDOM(node);
      };

      const btnReset = document.createElement('button');
      btnReset.className = 'pointer-btn btn-reset';
      btnReset.innerHTML = '<span>🔄</span> Reset';
      btnReset.onclick = () => {
        node.properties.points = [];
        saveCanvas();
        refreshNodeDOM(node);
      };

      toolbar.append(btnPos, btnNeg, btnReset);
      body.appendChild(toolbar);

      // Interaction Canvas
      const previewContainer = document.createElement('div');
      previewContainer.className = 'pointer-container resizable-box';
      previewContainer.id = `pointer-container-${node.id}`;
      
      if (node.properties.preview_width) {
        previewContainer.style.width = node.properties.preview_width + 'px';
        previewContainer.style.height = node.properties.preview_height + 'px';
      }
      previewContainer.onmouseup = () => {
        node.properties.preview_width = previewContainer.clientWidth;
        node.properties.preview_height = previewContainer.clientHeight;
        saveCanvas();
      };

      const isImageConnected = _connections.some(c => c.toNodeId === node.id && c.toPinName === 'image');

      if (!isImageConnected) {
        node.properties.last_preview = null;
        const placeholder = document.createElement('span');
        placeholder.className = 'preview-placeholder';
        placeholder.textContent = 'Connect Image input';
        previewContainer.appendChild(placeholder);
      } else {
        if (!node.properties.last_preview) {
          const placeholder = document.createElement('span');
          placeholder.className = 'preview-placeholder';
          placeholder.textContent = 'Loading Image...';
          previewContainer.appendChild(placeholder);
          setTimeout(() => updatePointerNodeImage(node.id), 0);
        } else {
          const wrapper = document.createElement('div');
          wrapper.className = 'pointer-img-wrapper';
          wrapper.id = `pointer-wrapper-${node.id}`;

          const img = document.createElement('img');
          img.className = 'pointer-img';
          img.id = `pointer-img-${node.id}`;
          img.src = `data:image/jpeg;base64,${node.properties.last_preview}`;
          img.draggable = false;

          img.onclick = (e) => {
            const rect = img.getBoundingClientRect();
            const x = (e.clientX - rect.left) / rect.width;
            const y = (e.clientY - rect.top) / rect.height;
            const label = node.properties.active_mode === 'positive' ? 1 : 0;
            node.properties.points.push({ x, y, label });
            saveCanvas();
            renderPointsOverlay(node);
          };

          wrapper.appendChild(img);
          previewContainer.appendChild(wrapper);
          setTimeout(() => renderPointsOverlay(node), 0);
        }
      }

      body.appendChild(previewContainer);
    } else if (node.type === 'save_annotation') {
      const pins = createPinsLayout(node,
        [
          { name: 'image', label: 'Image' },
          { name: 'annotation', label: 'Annotation' }
        ],
        []
      );
      body.appendChild(pins);

      // Output Directory Input & Browse Button
      const dirGroup = document.createElement('div');
      dirGroup.className = 'field-group';
      dirGroup.innerHTML = `<span class="field-label">Save Directory</span>`;

      const inputRow = document.createElement('div');
      inputRow.style.cssText = 'display:flex; gap:6px; align-items:center;';

      const dirInp = document.createElement('input');
      dirInp.className = 'field-input';
      dirInp.type = 'text';
      dirInp.placeholder = 'Select folder to save...';
      dirInp.value = node.properties.output_dir || '';
      dirInp.style.flex = '1';
      dirInp.oninput = () => {
        node.properties.output_dir = dirInp.value;
        saveCanvas();
      };

      const browseBtn = document.createElement('button');
      browseBtn.className = 'btn btn-secondary';
      browseBtn.style.cssText = 'padding:6px 10px; font-size:0.75rem; white-space:nowrap;';
      browseBtn.textContent = 'Browse...';
      browseBtn.onclick = async (e) => {
        e.preventDefault();
        browseBtn.disabled = true;
        browseBtn.textContent = 'Opening...';
        try {
          const r = await fetch('/api/select-folder', { method: 'POST' });
          const d = await r.json();
          if (d.success && d.path) {
            dirInp.value = d.path;
            node.properties.output_dir = d.path;
            saveCanvas();
            showToast('Folder selected: ' + d.path, 'success');
          } else if (d.message) {
            showToast(d.message, 'info');
          }
        } catch (err) {
          showToast('Failed to select folder: ' + err.message, 'error');
        } finally {
          browseBtn.disabled = false;
          browseBtn.textContent = 'Browse...';
        }
      };

      inputRow.append(dirInp, browseBtn);
      dirGroup.appendChild(inputRow);
      body.appendChild(dirGroup);

      // Console / Logs output
      const logsGroup = document.createElement('div');
      logsGroup.className = 'field-group';
      logsGroup.innerHTML = `
        <span class="field-label">Save Status & Logs</span>
        <div class="yolo-logs-container" id="yolo-logs-${node.id}">
          <span style="color:var(--text-muted);">No logs available. Run flow to save.</span>
        </div>
      `;
      const logsConsole = logsGroup.querySelector('.yolo-logs-container');
      if (node.properties.last_logs) {
        logsConsole.innerHTML = node.properties.last_logs;
      }
      body.appendChild(logsGroup);
    }

    el.append(header, body);
    nodesContainer.appendChild(el);
  }

  // Render classes list inside Input nodes
  function renderClassesList(node) {
    const list = document.getElementById(`class-list-${node.id}`);
    if (!list) return;
    list.innerHTML = '';

    node.properties.classes.forEach((c, idx) => {
      const row = document.createElement('div');
      row.className = 'class-item-row';

      const idxSpan = document.createElement('span');
      idxSpan.style.cssText = 'font-size:0.72rem; color:var(--text-muted); font-weight:600; min-width:14px;';
      idxSpan.textContent = idx;

      const nameInp = document.createElement('input');
      nameInp.className = 'class-input-name';
      nameInp.type = 'text';
      nameInp.value = c.name;
      nameInp.oninput = () => {
        c.name = nameInp.value;
        saveCanvas();
        refreshAllYoloBindings();
      };

      const colorInp = document.createElement('input');
      colorInp.className = 'class-input-color';
      colorInp.type = 'color';
      colorInp.value = c.color;
      colorInp.onchange = () => {
        c.color = colorInp.value;
        saveCanvas();
        refreshAllYoloBindings();
      };

      const delBtn = document.createElement('button');
      delBtn.className = 'node-close-btn';
      delBtn.textContent = '×';
      delBtn.onclick = () => {
        node.properties.classes.splice(idx, 1);
        renderClassesList(node);
        saveCanvas();
        refreshAllYoloBindings();
      };

      row.append(idxSpan, nameInp, colorInp, delBtn);
      list.appendChild(row);
    });
  }

  // Create simple labelled field input helper
  function createInputField(labelText, type, value, onChange) {
    const group = document.createElement('div');
    group.className = 'field-group';
    
    const label = document.createElement('span');
    label.className = 'field-label';
    label.textContent = labelText;
    
    const inp = document.createElement('input');
    inp.className = 'field-input';
    inp.type = type;
    inp.value = value || '';
    inp.oninput = () => onChange(inp.value);

    group.append(label, inp);
    return group;
  }

  // --- Dynamic Class Bindings Engine ---
  async function refreshYoloBindings(yoloNodeId) {
    const bindingList = document.getElementById(`binding-list-${yoloNodeId}`);
    if (!bindingList) return;

    const yoloNode = _nodes.find(n => n.id === yoloNodeId);
    if (!yoloNode) return;

    // Find if a class connection is made to the YOLO node
    let connectedClassSourceNode = null;
    for (const conn of _connections) {
      if (conn.toNodeId === yoloNodeId && conn.toPinName === 'class') {
        const fromNode = _nodes.find(n => n.id === conn.fromNodeId);
        if (fromNode) {
          connectedClassSourceNode = fromNode;
          break;
        }
      }
    }

    if (!connectedClassSourceNode) {
      bindingList.innerHTML = `<span style="font-size:0.72rem; color:var(--text-muted);">Connect Class output to YOLO to configure bindings</span>`;
      yoloNode.properties.class_bindings = {};
      return;
    }

    // Fetch classes of selected YOLO model
    const modelName = yoloNode.properties.model;
    bindingList.innerHTML = `<span style="font-size:0.72rem; color:var(--text-muted);">Memuat class model...</span>`;

    try {
      const r = await fetch(`/api/yolo-model-names?model=${encodeURIComponent(modelName)}`);
      const d = await r.json();
      if (!d.success || !d.names) {
        bindingList.innerHTML = `<span style="font-size:0.72rem; color:#ef4444;">Gagal memuat class model: ${d.error || ''}</span>`;
        return;
      }

      bindingList.innerHTML = '';
      const modelClasses = d.names;
      const inputClasses = connectedClassSourceNode.properties.classes || [];

      if (modelClasses.length === 0) {
        bindingList.innerHTML = `<span style="font-size:0.72rem; color:var(--text-muted);">Tidak ada class pada model</span>`;
        return;
      }

      // Build bindings UI rows
      modelClasses.forEach((mName, mIdx) => {
        const row = document.createElement('div');
        row.className = 'binding-row';

        const label = document.createElement('span');
        label.textContent = `${mIdx}: ${mName}`;
        label.style.cssText = 'overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:140px;';

        const select = document.createElement('select');
        select.className = 'binding-select';

        const optEmpty = document.createElement('option');
        optEmpty.value = ''; optEmpty.textContent = 'None';
        select.appendChild(optEmpty);

        inputClasses.forEach((iClass, iIdx) => {
          const opt = document.createElement('option');
          opt.value = iIdx; opt.textContent = `${iIdx}: ${iClass.name}`;
          select.appendChild(opt);
        });

        // Restore saved binding value
        const currentBindingVal = yoloNode.properties.class_bindings[mIdx];
        if (currentBindingVal !== undefined && currentBindingVal !== "") {
          select.value = currentBindingVal;
        }

        select.onchange = () => {
          yoloNode.properties.class_bindings[mIdx] = select.value;
          saveCanvas();
        };

        row.append(label, select);
        bindingList.appendChild(row);
      });

    } catch (e) {
      bindingList.innerHTML = `<span style="font-size:0.72rem; color:#ef4444;">Error memuat class model</span>`;
    }
  }

  async function refreshSam3Bindings(nodeId) {
    const bindingList = document.getElementById(`binding-list-${nodeId}`);
    if (!bindingList) return;

    const node = _nodes.find(n => n.id === nodeId);
    if (!node) return;

    // Find if a class connection is made to the SAM3 node
    let connectedClassSourceNode = null;
    for (const conn of _connections) {
      if (conn.toNodeId === nodeId && conn.toPinName === 'class') {
        const fromNode = _nodes.find(n => n.id === conn.fromNodeId);
        if (fromNode) {
          connectedClassSourceNode = fromNode;
          break;
        }
      }
    }

    if (!connectedClassSourceNode) {
      bindingList.innerHTML = `<span style="font-size:0.72rem; color:var(--text-muted);">Connect Class output to SAM3 to configure bindings</span>`;
      node.properties.prompt_bindings = {};
      return;
    }

    const inputClasses = connectedClassSourceNode.properties.classes || [];
    bindingList.innerHTML = '';

    // Create prompt addition form
    const addForm = document.createElement('div');
    addForm.style.cssText = 'display:flex; gap:6px; margin-bottom:8px;';

    const promptInp = document.createElement('input');
    promptInp.type = 'text';
    promptInp.className = 'field-input';
    promptInp.placeholder = 'Prompt (e.g. car)';
    promptInp.style.flex = '1';
    promptInp.style.fontSize = '0.72rem';
    promptInp.style.padding = '4px 8px';

    const classSel = document.createElement('select');
    classSel.className = 'binding-select';
    classSel.style.fontSize = '0.72rem';
    classSel.style.padding = '4px';
    classSel.style.minWidth = '80px';
    inputClasses.forEach((c, idx) => {
      const opt = document.createElement('option');
      opt.value = idx;
      opt.textContent = c.name;
      classSel.appendChild(opt);
    });

    const addBtn = document.createElement('button');
    addBtn.className = 'btn-add-class';
    addBtn.style.cssText = 'padding: 4px 8px; font-size:0.72rem; margin:0;';
    addBtn.textContent = 'Add';
    addBtn.onclick = (e) => {
      e.preventDefault();
      const pText = promptInp.value.trim();
      if (!pText) return;
      node.properties.prompt_bindings[pText] = classSel.value;
      promptInp.value = '';
      refreshSam3Bindings(nodeId);
      saveCanvas();
    };

    addForm.append(promptInp, classSel, addBtn);
    bindingList.appendChild(addForm);

    // List existing prompt bindings
    const bindings = node.properties.prompt_bindings || {};
    const promptKeys = Object.keys(bindings);

    if (promptKeys.length === 0) {
      const placeholder = document.createElement('div');
      placeholder.style.cssText = 'font-size:0.72rem; color:var(--text-muted); text-align:center; padding:4px;';
      placeholder.textContent = 'No prompt bindings. Add one above.';
      bindingList.appendChild(placeholder);
      return;
    }

    promptKeys.forEach(pText => {
      const row = document.createElement('div');
      row.className = 'binding-row';

      const label = document.createElement('span');
      label.textContent = pText;
      label.style.cssText = 'overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:110px; font-size:0.72rem; font-weight:500;';

      const select = document.createElement('select');
      select.className = 'binding-select';
      inputClasses.forEach((c, idx) => {
        const opt = document.createElement('option');
        opt.value = idx; opt.textContent = c.name;
        select.appendChild(opt);
      });
      select.value = bindings[pText];
      select.onchange = () => {
        node.properties.prompt_bindings[pText] = select.value;
        saveCanvas();
      };

      const delBtn = document.createElement('button');
      delBtn.className = 'node-close-btn';
      delBtn.textContent = '×';
      delBtn.style.fontSize = '0.9rem';
      delBtn.style.padding = '0 4px';
      delBtn.onclick = () => {
        delete node.properties.prompt_bindings[pText];
        refreshSam3Bindings(nodeId);
        saveCanvas();
      };

      row.append(label, select, delBtn);
      bindingList.appendChild(row);
    });
  }

  function getAiDecisionInputClasses(nodeId) {
    for (const conn of _connections) {
      if (conn.toNodeId === nodeId && conn.toPinName === 'class') {
        const fromNode = _nodes.find(n => n.id === conn.fromNodeId);
        if (fromNode && fromNode.properties && fromNode.properties.classes) {
          return fromNode.properties.classes;
        }
      }
    }
    return [];
  }

  function generateAiPromptPreviewText(node) {
    let rawPrompt = (node.properties.global_rules || '').trim();
    if (!rawPrompt) {
      rawPrompt = `System Prompt: Evaluasi pasangan anotasi terdeteksi dan pilih hasil yang paling tepat.\n\nClass Rules:\n{class_rules}\n\nAvailable Classes: {class}\n\nConflict Inputs:\n{image_input}`;
    }

    // 1. {class_rules} replacement
    const classRulesMap = node.properties.class_rules || {};
    const inputClasses = getAiDecisionInputClasses(node.id);
    let classRulesStr = '';
    const ruleKeys = Object.keys(classRulesMap);
    if (ruleKeys.length > 0) {
      classRulesStr = ruleKeys.map(rText => {
        const cIdx = classRulesMap[rText];
        const cName = (cIdx !== undefined && cIdx < inputClasses.length) ? inputClasses[cIdx].name : `Class ${cIdx}`;
        return `- Rule "${rText}" -> Target: ${cName}`;
      }).join('\n');
    } else {
      classRulesStr = '- (Belum ada aturan kelas)';
    }

    // 2. {class} replacement
    let classesStr = '';
    if (inputClasses.length > 0) {
      classesStr = inputClasses.map((c, idx) => `[${idx}: ${c.name}]`).join(', ');
    } else {
      classesStr = '[0: car], [1: truck], [2: bus], [3: motorcycle]';
    }

    // 3. {image_input} replacement
    const sampleImageInput = `image 1: car\nimage 2: truck\nimage 3: truck`;

    let preview = rawPrompt;
    preview = preview.replace(/\{class_rules\}/g, classRulesStr);
    preview = preview.replace(/\{class\}/g, classesStr);
    preview = preview.replace(/\{image_input\}/g, sampleImageInput);

    return preview;
  }

  function updateAiPromptPreview(nodeId) {
    const previewBox = document.getElementById(`ai-prompt-preview-${nodeId}`);
    if (!previewBox) return;
    const node = _nodes.find(n => n.id === nodeId);
    if (!node) return;
    previewBox.textContent = generateAiPromptPreviewText(node);
  }

  async function refreshAiDecisionRules(nodeId) {
    const rulesList = document.getElementById(`rules-list-${nodeId}`);
    if (!rulesList) return;

    const node = _nodes.find(n => n.id === nodeId);
    if (!node) return;

    if (typeof node.properties.class_rules === 'string') {
      const oldStr = node.properties.class_rules;
      node.properties.class_rules = {};
      if (oldStr.trim() !== '') {
        node.properties.class_rules[oldStr] = '0';
      }
      saveCanvas();
    }

    let connectedClassSourceNode = null;
    for (const conn of _connections) {
      if (conn.toNodeId === nodeId && conn.toPinName === 'class') {
        const fromNode = _nodes.find(n => n.id === conn.fromNodeId);
        if (fromNode) {
          connectedClassSourceNode = fromNode;
          break;
        }
      }
    }

    const classListContainer = document.getElementById(`class-list-container-${nodeId}`);

    if (!connectedClassSourceNode) {
      rulesList.innerHTML = `<span style="font-size:0.72rem; color:var(--text-muted);">Hubungkan output Class ke node ini untuk mengonfigurasi aturan kelas</span>`;
      node.properties.class_rules = {};
      if (classListContainer) classListContainer.innerHTML = '';
      return;
    }

    const inputClasses = connectedClassSourceNode.properties.classes || [];
    rulesList.innerHTML = '';

    if (classListContainer) {
      classListContainer.innerHTML = `
        <span class="field-label" style="font-size:0.7rem; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.03em;">Available Classes</span>
        <div style="display:flex; flex-direction:column; gap:4px; margin-top:4px; background:rgba(255,255,255,0.01); border:1px solid var(--border); border-radius:6px; padding:6px 10px;">
          ${inputClasses.map((c, idx) => `
            <div style="display:flex; justify-content:space-between; font-size:0.75rem; font-family:monospace;">
              <span style="color:var(--accent); font-weight:600;">[${idx}]</span>
              <span style="color:var(--text-primary);">${c.name}</span>
            </div>
          `).join('')}
        </div>
      `;
    }

    const addForm = document.createElement('div');
    addForm.style.cssText = 'display:flex; flex-direction:column; gap:6px; margin-bottom:8px; background:rgba(255,255,255,0.02); padding:8px; border:1px solid var(--border); border-radius:6px;';

    const ruleTextarea = document.createElement('textarea');
    ruleTextarea.className = 'field-input';
    ruleTextarea.placeholder = 'Definisi aturan (misal: semua mobil kecil, minibus...)';
    ruleTextarea.style.cssText = 'width:100%; min-height:48px; font-size:0.72rem; padding:4px 8px; resize:vertical; box-sizing:border-box;';

    const selectRow = document.createElement('div');
    selectRow.style.cssText = 'display:flex; gap:6px; align-items:center;';

    const classSel = document.createElement('select');
    classSel.className = 'binding-select';
    classSel.style.cssText = 'flex:1; font-size:0.72rem; padding:4px;';
    inputClasses.forEach((c, idx) => {
      const opt = document.createElement('option');
      opt.value = idx;
      opt.textContent = c.name;
      classSel.appendChild(opt);
    });

    const addBtn = document.createElement('button');
    addBtn.className = 'btn';
    addBtn.style.cssText = 'padding: 4px 12px; font-size:0.72rem; background:var(--accent);';
    addBtn.textContent = 'Add Rule';
    addBtn.onclick = (e) => {
      e.preventDefault();
      const rText = ruleTextarea.value.trim();
      if (!rText) return;
      if (!node.properties.class_rules) node.properties.class_rules = {};
      node.properties.class_rules[rText] = classSel.value;
      ruleTextarea.value = '';
      refreshAiDecisionRules(nodeId);
      saveCanvas();
    };

    selectRow.append(classSel, addBtn);
    addForm.append(ruleTextarea, selectRow);
    rulesList.appendChild(addForm);

    const rules = node.properties.class_rules || {};
    const ruleKeys = Object.keys(rules);

    if (ruleKeys.length === 0) {
      const placeholder = document.createElement('div');
      placeholder.style.cssText = 'font-size:0.72rem; color:var(--text-muted); text-align:center; padding:4px;';
      placeholder.textContent = 'Belum ada aturan kelas. Tambahkan di atas.';
      rulesList.appendChild(placeholder);
      return;
    }

    ruleKeys.forEach(rText => {
      const row = document.createElement('div');
      row.className = 'binding-row';
      row.style.cssText = 'display:flex; flex-direction:column; gap:4px; border:1px solid var(--border); border-radius:6px; padding:6px; margin-bottom:6px; background:rgba(0,0,0,0.1);';

      const ruleInput = document.createElement('textarea');
      ruleInput.className = 'field-input';
      ruleInput.value = rText;
      ruleInput.disabled = true; // Locked by default
      ruleInput.style.cssText = 'width:100%; min-height:36px; font-size:0.72rem; padding:4px 8px; resize:vertical; box-sizing:border-box; background:transparent; border:none; color:var(--text-primary); font-family:inherit; outline:none; cursor:default;';

      const editRow = document.createElement('div');
      editRow.style.cssText = 'display:flex; gap:6px; align-items:center;';

      const select = document.createElement('select');
      select.className = 'binding-select';
      select.style.cssText = 'flex:1; font-size:0.72rem; padding:4px;';
      select.disabled = true; // Locked by default
      inputClasses.forEach((c, idx) => {
        const opt = document.createElement('option');
        opt.value = idx; opt.textContent = c.name;
        select.appendChild(opt);
      });
      select.value = rules[rText];
      select.onchange = () => {
        node.properties.class_rules[currentKey] = select.value;
        saveCanvas();
      };

      const editBtn = document.createElement('button');
      editBtn.className = 'pointer-btn';
      editBtn.style.cssText = 'border:1px solid var(--border); background:none; color:var(--text-muted); cursor:pointer; font-size:0.7rem; padding:2px 6px; border-radius:4px; display:inline-flex; align-items:center; justify-content:center;';
      editBtn.textContent = '✏️';
      editBtn.title = 'Edit Rule';

      const delBtn = document.createElement('button');
      delBtn.className = 'node-close-btn';
      delBtn.textContent = '×';
      delBtn.style.cssText = 'font-size: 1.1rem; padding: 0 6px; cursor:pointer; color:#ef4444; background:none; border:none;';

      let isEditing = false;
      let currentKey = rText;

      const toggleEdit = () => {
        isEditing = !isEditing;
        if (isEditing) {
          ruleInput.disabled = false;
          select.disabled = false;
          ruleInput.style.border = '1px solid var(--accent)';
          ruleInput.style.background = 'var(--bg-primary)';
          ruleInput.style.cursor = 'text';
          editBtn.textContent = '✔️';
          editBtn.title = 'Save Rule';
          ruleInput.focus();
        } else {
          const newKey = ruleInput.value.trim();
          if (newKey && newKey !== currentKey) {
            const val = node.properties.class_rules[currentKey];
            delete node.properties.class_rules[currentKey];
            node.properties.class_rules[newKey] = val;
            currentKey = newKey;
          } else if (!newKey) {
            delete node.properties.class_rules[currentKey];
            refreshAiDecisionRules(nodeId);
            saveCanvas();
            return;
          }
          ruleInput.disabled = true;
          select.disabled = true;
          ruleInput.style.border = 'none';
          ruleInput.style.background = 'transparent';
          ruleInput.style.cursor = 'default';
          editBtn.textContent = '✏️';
          editBtn.title = 'Edit Rule';
          saveCanvas();
        }
      };

      editBtn.onclick = (e) => {
        e.preventDefault();
        toggleEdit();
      };



      delBtn.onclick = () => {
        delete node.properties.class_rules[currentKey];
        refreshAiDecisionRules(nodeId);
        saveCanvas();
      };

      editRow.append(select, editBtn, delBtn);
      row.append(ruleInput, editRow);
      rulesList.appendChild(row);
    });
  }

  function refreshAllYoloBindings() {
    _nodes.forEach(n => {
      if (n.type === 'yolo_detector') {
        refreshYoloBindings(n.id);
      } else if (n.type === 'sam3') {
        refreshSam3Bindings(n.id);
      } else if (n.type === 'ai_decision') {
        refreshAiDecisionRules(n.id);
      }
    });
  }

  // --- Node Dragging Handler ---
  let _dragNodeState = null;
  function startDragNode(e, nodeId) {
    if (e.target.tagName === 'BUTTON' || e.target.closest('button')) return;
    e.preventDefault();
    const node = _nodes.find(n => n.id === nodeId);
    if (!node) return;

    selectNode(nodeId);

    _dragNodeState = {
      nodeId,
      startX: e.clientX,
      startY: e.clientY,
      nodeX: node.x,
      nodeY: node.y
    };
  }

  function startConnectionDrag(e, nodeId, pinName, pinType) {
    e.preventDefault();
    e.stopPropagation();
    
    // Find pin coordinates relative to canvas-content
    const pinEl = e.target;
    const pinRect = pinEl.getBoundingClientRect();
    const contentRect = canvasContent.getBoundingClientRect();

    _draftConn = {
      fromNodeId: nodeId,
      fromPinName: pinName,
      fromPinType: pinType,
      startX: (pinRect.left + pinRect.width/2 - contentRect.left) / _zoom,
      startY: (pinRect.top + pinRect.height/2 - contentRect.top) / _zoom,
      mouseX: (pinRect.left + pinRect.width/2 - contentRect.left) / _zoom,
      mouseY: (pinRect.top + pinRect.height/2 - contentRect.top) / _zoom
    };
  }

  function selectNode(nodeId) {
    _selectedNodeId = nodeId;
    document.querySelectorAll('.node').forEach(el => {
      if (el.id === nodeId) el.classList.add('selected');
      else el.classList.remove('selected');
    });
  }

  function renderConnections() {
    svgOverlay.innerHTML = '';
    const contentRect = canvasContent.getBoundingClientRect();

    _connections.forEach(conn => {
      const fromNodeEl = document.getElementById(conn.fromNodeId);
      const toNodeEl = document.getElementById(conn.toNodeId);
      if (!fromNodeEl || !toNodeEl) return;

      const fromPin = fromNodeEl.querySelector(`.pin-out[data-pin-name="${conn.fromPinName}"]`);
      const toPin = toNodeEl.querySelector(`.pin-in[data-pin-name="${conn.toPinName}"]`);
      if (!fromPin || !toPin) return;

      const fromRect = fromPin.getBoundingClientRect();
      const toRect = toPin.getBoundingClientRect();

      const fx = (fromRect.left + fromRect.width/2 - contentRect.left) / _zoom;
      const fy = (fromRect.top + fromRect.height/2 - contentRect.top) / _zoom;
      const tx = (toRect.left + toRect.width/2 - contentRect.left) / _zoom;
      const ty = (toRect.top + toRect.height/2 - contentRect.top) / _zoom;

      drawBezierPath(fx, fy, tx, ty, false);
    });

    // Draw draft line if dragging connection
    if (_draftConn) {
      drawBezierPath(_draftConn.startX, _draftConn.startY, _draftConn.mouseX, _draftConn.mouseY, true);
    }
  }

  function drawBezierPath(x1, y1, x2, y2, isDraft) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    
    // Control points for smooth bezier curve
    const dx = Math.abs(x2 - x1) * 0.5;
    const cp1x = x1 + dx;
    const cp1y = y1;
    const cp2x = x2 - dx;
    const cp2y = y2;
    
    const dStr = `M ${x1} ${y1} C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${x2} ${y2}`;
    
    path.setAttribute('d', dStr);
    path.setAttribute('class', isDraft ? 'connection-line draft' : 'connection-line');
    svgOverlay.appendChild(path);
  }

  function onDocumentMouseMove(e) {
    const wrapRect = canvasWrap.getBoundingClientRect();
    const contentRect = canvasContent.getBoundingClientRect();

    // Handling Canvas Panning
    if (_isPanning) {
      const dx = e.clientX - _startPanMouseX;
      const dy = e.clientY - _startPanMouseY;
      _panX = _startPanX + dx;
      _panY = _startPanY + dy;
      canvasContent.style.transform = `translate(${_panX}px, ${_panY}px) scale(${_zoom})`;
    }

    // Handling Node Dragging
    if (_dragNodeState) {
      // Delta mouse movements must be divided by _zoom to map from viewport pixels to local canvas coordinates
      const dx = (e.clientX - _dragNodeState.startX) / _zoom;
      const dy = (e.clientY - _dragNodeState.startY) / _zoom;
      const node = _nodes.find(n => n.id === _dragNodeState.nodeId);
      if (node) {
        node.x = _dragNodeState.nodeX + dx;
        node.y = _dragNodeState.nodeY + dy;
        
        const nodeEl = document.getElementById(node.id);
        if (nodeEl) {
          nodeEl.style.left = node.x + 'px';
          nodeEl.style.top = node.y + 'px';
        }
        renderConnections();
      }
    }

    // Handling Connection Dragging
    if (_draftConn) {
      _draftConn.mouseX = (e.clientX - contentRect.left) / _zoom;
      _draftConn.mouseY = (e.clientY - contentRect.top) / _zoom;
      renderConnections();
    }
  }

  function onDocumentMouseUp(e) {
    // End Canvas Panning
    if (_isPanning) {
      _isPanning = false;
      canvasWrap.style.cursor = 'default';
      localStorage.setItem('annodes_pan_x', _panX);
      localStorage.setItem('annodes_pan_y', _panY);
    }

    // End Node Dragging
    if (_dragNodeState) {
      _dragNodeState = null;
      saveCanvas();
    }

    // End Connection Dragging
    if (_draftConn) {
      const targetPin = e.target.closest('.pin-in');
      if (targetPin) {
        const toNodeId = targetPin.getAttribute('data-node-id');
        const toPinName = targetPin.getAttribute('data-pin-name');
        const fromNodeId = _draftConn.fromNodeId;
        const fromPinName = _draftConn.fromPinName;
        
        // Prevent self connection
        if (fromNodeId !== toNodeId) {
          // Remove existing connection going to the same input terminal
          _connections = _connections.filter(c => !(c.toNodeId === toNodeId && c.toPinName === toPinName));
          
          // Add connection
          _connections.push({
            id: 'conn-' + Date.now(),
            fromNodeId,
            fromPinName,
            toNodeId,
            toPinName
          });
          
          saveCanvas();
          
          // Re-render and trigger bindings config if connected to YOLO or SAM3 class
          renderAll(); 
          if (toNodeId) {
            const targetNode = _nodes.find(n => n.id === toNodeId);
            if (targetNode) {
              if (targetNode.type === 'yolo_detector') {
                refreshYoloBindings(toNodeId);
              } else if (targetNode.type === 'sam3') {
                refreshSam3Bindings(toNodeId);
              } else if (targetNode.type === 'ai_decision') {
                refreshAiDecisionRules(toNodeId);
              } else if (targetNode.type === 'pointer') {
                updatePointerNodeImage(toNodeId);
              }
            }
          }
        }
      }
      _draftConn = null;
      renderConnections();
    }
  }

  // --- Canvas Render Helper ---
  function renderAll() {
    nodesContainer.innerHTML = '';
    _nodes.forEach(n => renderNodeDOM(n));
    renderConnections();
  }

  // --- Save / Load Graph Layout State ---
  async function saveCanvas() {
    const payload = {
      nodes: JSON.stringify(_nodes),
      connections: JSON.stringify(_connections)
    };
    try {
      await fetch('/api/save-canvas', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    } catch (e) { console.error('Failed to save canvas to database', e); }
  }

  async function loadCanvas() {
    try {
      const r = await fetch('/api/load-canvas');
      const d = await r.json();
      if (d.success) {
        _nodes = d.nodes || [];
        _connections = d.connections || [];
        _activeTabId = d.tab_id;
        
        if (window.location.pathname === '/' || window.location.pathname === '') {
          window.history.replaceState(null, '', '/' + d.tab_id);
        }
      }
    } catch (e) {
      console.warn('Failed to load canvas', e);
      showToast('Gagal memuat canvas dari DB', 'error');
    }
  }
   // --- Floating Log Console Window & Progress Tracker ---
  let _flowLogState = {
    totalNodes: 0,
    completedNodes: 0
  };

  function showFlowLogWindow() {
    let win = document.getElementById('flow-log-window');
    if (!win) {
      win = document.createElement('div');
      win.id = 'flow-log-window';
      win.className = 'floating-log-window';
      win.innerHTML = `
        <div class="floating-log-header" id="flow-log-header">
          <div class="floating-log-title">
            <svg viewBox="0 0 24 24" style="width:16px;height:16px;fill:currentColor">
              <path d="M13,0V6H19L11,24V18H5L13,0Z"/>
            </svg>
            Flow Execution Logs & Progress
          </div>
          <div class="floating-log-controls">
            <button class="floating-log-btn" id="flow-log-clear-btn" title="Clear logs">🗑️ Clear</button>
            <button class="floating-log-btn" id="flow-log-close-btn" title="Tutup Log Window">✕</button>
          </div>
        </div>
        <div class="floating-log-body">
          <div class="progress-info-row">
            <span id="flow-progress-status" style="color:var(--text-secondary); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:320px;">Ready</span>
            <span id="flow-progress-percent" style="color:#10b981; font-weight:700;">0%</span>
          </div>
          <div class="progress-bar-container">
            <div class="progress-bar-fill" id="flow-progress-bar"></div>
          </div>
          <div class="log-terminal" id="flow-log-console">
            <div class="log-line-info">[SYSTEM] Flow Log Console initialized.</div>
          </div>
        </div>
      `;
      document.body.appendChild(win);

      // Draggable window header
      const header = win.querySelector('#flow-log-header');
      let isDragging = false, startX, startY, initialLeft, initialTop;

      header.onmousedown = (e) => {
        if (e.target.closest('.floating-log-btn')) return;
        isDragging = true;
        startX = e.clientX;
        startY = e.clientY;
        const rect = win.getBoundingClientRect();
        initialLeft = rect.left;
        initialTop = rect.top;
        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
      };

      function onMouseMove(e) {
        if (!isDragging) return;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        win.style.left = `${initialLeft + dx}px`;
        win.style.top = `${initialTop + dy}px`;
        win.style.right = 'auto';
      }

      function onMouseUp() {
        isDragging = false;
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
      }

      // Close & Clear Buttons
      win.querySelector('#flow-log-close-btn').onclick = () => {
        win.style.display = 'none';
      };
      win.querySelector('#flow-log-clear-btn').onclick = () => {
        const consoleEl = win.querySelector('#flow-log-console');
        if (consoleEl) consoleEl.innerHTML = '<div class="log-line-info">[SYSTEM] Logs cleared.</div>';
      };
    } else {
      win.style.display = 'flex';
    }
    return win;
  }

  function updateFlowProgress(percent, statusText) {
    showFlowLogWindow();
    const fillEl = document.getElementById('flow-progress-bar');
    const pctEl = document.getElementById('flow-progress-percent');
    const statusEl = document.getElementById('flow-progress-status');
    if (fillEl) fillEl.style.width = `${Math.min(100, Math.max(0, percent))}%`;
    if (pctEl) pctEl.textContent = `${Math.round(percent)}%`;
    if (statusEl && statusText) statusEl.textContent = statusText;
  }

  function appendFlowLogLine(text, level = 'info') {
    showFlowLogWindow();
    const consoleEl = document.getElementById('flow-log-console');
    if (!consoleEl) return;
    
    const timeStr = new Date().toLocaleTimeString('id-ID', { hour12: false });
    const line = document.createElement('div');
    line.className = `log-line-${level}`;
    line.textContent = `[${timeStr}] ${text}`;
    
    consoleEl.appendChild(line);
    consoleEl.scrollTop = consoleEl.scrollHeight;
  }

  async function handleFlowEvent(ev) {
    if (ev.type === 'start') {
      const nodeEl = document.getElementById(ev.node_id);
      if (nodeEl) {
        nodeEl.classList.add('processing-glow');
      }
      const n = _nodes.find(node => node.id === ev.node_id);
      const nodeTitle = n ? `${n.type.toUpperCase()} (${ev.node_id})` : ev.node_id;
      appendFlowLogLine(`[START] Evaluating node: ${nodeTitle}`, 'start');
      const pct = Math.min(95, Math.round((_flowLogState.completedNodes / Math.max(1, _flowLogState.totalNodes)) * 100));
      updateFlowProgress(pct, `Running ${nodeTitle}...`);

    } else if (ev.type === 'end') {
      const nodeEl = document.getElementById(ev.node_id);
      if (nodeEl) {
        nodeEl.classList.remove('processing-glow');
      }
      _flowLogState.completedNodes++;
      const pct = Math.min(99, Math.round((_flowLogState.completedNodes / Math.max(1, _flowLogState.totalNodes)) * 100));
      updateFlowProgress(pct, `Finished node ${ev.node_id}`);

    } else if (ev.type === 'preview') {
      const nodeId = ev.node_id;
      const node = _nodes.find(n => n.id === nodeId);
      if (node) {
        const previewData = ev.preview;
        node.properties.last_preview = previewData;
        node.properties.last_logs = ev.logs;

        if (node.type === 'preview' || node.type === 'overlap_comparator') {
          renderPreviewContent(nodeId, previewData);
          
          const nodeEl = document.getElementById(nodeId);
          if (nodeEl) {
            nodeEl.classList.add('preview-pulse-glow');
            setTimeout(() => {
              nodeEl.classList.remove('preview-pulse-glow');
            }, 2000);
          }
        } else {
          const previewImg = document.getElementById(`preview-img-${nodeId}`);
          const previewPlaceholder = document.querySelector(`#preview-container-${nodeId} .preview-placeholder`);
          const base64 = Array.isArray(previewData) ? previewData[0] : previewData;
          
          if (previewImg && base64) {
            previewImg.src = `data:image/jpeg;base64,${base64}`;
            previewImg.style.display = 'block';
            if (previewPlaceholder) previewPlaceholder.style.display = 'none';
          }
        }

        if (ev.logs) {
          const logsConsole = document.getElementById(`yolo-logs-${nodeId}`);
          if (logsConsole) {
            logsConsole.innerHTML = ev.logs;
            logsConsole.scrollTop = logsConsole.scrollHeight;
          }
          const tempDiv = document.createElement('div');
          tempDiv.innerHTML = ev.logs;
          const cleanLogText = tempDiv.textContent || tempDiv.innerText || '';
          if (cleanLogText.trim()) {
            appendFlowLogLine(`[NODE LOG] ${node.type.toUpperCase()}: ${cleanLogText.trim()}`, 'success');
          }
        } else {
          appendFlowLogLine(`[OUTPUT] Generated result for ${node.type.toUpperCase()} (${nodeId})`, 'success');
        }
        
        saveCanvas();
      }
    } else if (ev.type === 'done') {
      const statusText = ev.is_folder_mode ? `Folder Image ${ev.current_index + 1}/${ev.total_images}: ${ev.filename}` : `Completed: ${ev.filename || 'Flow Done'}`;
      updateFlowProgress(100, statusText);
      appendFlowLogLine(`[DONE] ${statusText}`, 'success');
      showToast(`Berhasil memproses: ${ev.filename || ''}`, 'success');
      saveCanvas();
    } else if (ev.type === 'error') {
      appendFlowLogLine(`[ERROR] ${ev.message}`, 'error');
      showToast(ev.message || 'Terjadi kesalahan saat memproses flow.', 'error');
    }
  }

  // --- Execute Flow (Run Flow) ---
  window.runFlow = async function (runOnlyNodes = null) {
    showFlowLogWindow();
    _flowLogState.completedNodes = 0;
    _flowLogState.totalNodes = runOnlyNodes ? runOnlyNodes.length : _nodes.length;
    updateFlowProgress(5, 'Initializing flow execution...');
    appendFlowLogLine('=== RUN FLOW STARTED ===', 'info');
    showToast('Menjalankan flow auto-annotation...', 'info');
    
    // Auto save layout before execution
    await saveCanvas();

    // Clear old previews and logs of target nodes before running
    const targetNodes = runOnlyNodes ? _nodes.filter(n => runOnlyNodes.includes(n.id)) : _nodes;
    targetNodes.forEach(n => {
      n.properties.last_preview = null;
      n.properties.last_logs = null;

      const previewImg = document.getElementById(`preview-img-${n.id}`);
      const previewPlaceholder = document.querySelector(`#preview-container-${n.id} .preview-placeholder`);
      
      if (previewImg) {
        // Node has an <img> element (yolo_detector, sam3, pointer)
        previewImg.src = '';
        previewImg.style.display = 'none';
        if (previewPlaceholder) {
          previewPlaceholder.style.display = 'block';
          previewPlaceholder.textContent = 'Memproses...';
        }
      } else {
        // Multi-card container nodes (preview, overlap_comparator, ai_decision)
        const previewContainer = document.getElementById(`preview-container-${n.id}`);
        if (previewContainer) {
          previewContainer.innerHTML = '<span class="preview-placeholder">Memproses...</span>';
        }
      }

      // Clear DOM logs console
      const logsConsole = document.getElementById(`yolo-logs-${n.id}`);
      if (logsConsole) {
        logsConsole.innerHTML = '<div style="color:var(--text-muted);">Memproses flow...</div>';
      }
    });

    // Refresh all pointer node images from backend
    _nodes.forEach(n => {
      if (n.type === 'pointer') {
        updatePointerNodeImage(n.id);
      }
    });

    // Reset any existing processing glow styles
    document.querySelectorAll('.node').forEach(el => {
      el.classList.remove('processing-glow', 'preview-pulse-glow');
    });

    try {
      const payload = {
        nodes: _nodes,
        connections: _connections
      };
      if (runOnlyNodes) {
        payload.run_only_nodes = runOnlyNodes;
      }

      const r = await fetch('/api/run-flow', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      
      if (!r.ok) {
        let errDetail = `HTTP error! status: ${r.status}`;
        try {
          const errJson = await r.json();
          if (errJson && errJson.detail) {
            errDetail = errJson.detail;
          }
        } catch (e) {}
        showToast(`Run Flow Error: ${errDetail}`, 'error');
        throw new Error(errDetail);
      }

      const reader = r.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        
        buffer = lines.pop(); // save trailing line

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const ev = JSON.parse(line);
            await handleFlowEvent(ev);
          } catch (err) {
            console.error('Failed to parse event line:', line, err);
          }
        }
      }

      if (buffer.trim()) {
        try {
          const ev = JSON.parse(buffer);
          await handleFlowEvent(ev);
        } catch (err) {
          console.error('Failed to parse final event buffer:', buffer, err);
        }
      }
    } catch (e) {
      console.error('Run flow error:', e);
      showToast('Gagal terhubung ke backend server', 'error');
      
      // Cleanup glows
      document.querySelectorAll('.node').forEach(el => {
        el.classList.remove('processing-glow', 'preview-pulse-glow');
      });
    }
  };

  // --- Toast Notification helper ---
  window.showToast = function (message, type = 'info') {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const el = document.createElement('div');
    el.className = `toast ${type}`;
    
    let icon = '';
    if (type === 'error') {
      icon = `<svg viewBox="0 0 24 24" style="width:14px;height:14px;fill:#ef4444;"><path d="M12,2C17.53,2 22,6.47 22,12C22,17.53 17.53,22 12,22C6.47,22 2,17.53 2,12C2,6.47 6.47,2 12,2M15.59,7L12,10.59L8.41,7L7,8.41L10.59,12L7,15.59L8.41,17L12,13.41L15.59,17L17,15.59L13.41,12L17,8.41L15.59,7Z"/></svg>`;
    } else if (type === 'success') {
      icon = `<svg viewBox="0 0 24 24" style="width:14px;height:14px;fill:#10b981;"><path d="M12,2C17.52,2 22,6.48 22,12C22,17.52 17.52,22 12,22C6.48,22 2,17.52 2,12C2,6.48 6.48,2 12,2M10,17L18,9L16.59,7.58L10,14.17L7.41,11.59L6,13L10,17Z"/></svg>`;
    } else {
      icon = `<svg viewBox="0 0 24 24" style="width:14px;height:14px;fill:#3b82f6;"><path d="M11,9H13V7H11M12,20C7.59,20 4,16.41 4,12C4,7.59 7.59,4 12,4C16.41,4 20,7.59 20,12C20,16.41 16.41,20 12,20M12,2A10,10 0 0,0 2,12A10,10 0 0,0 12,22A10,10 0 0,0 22,12A10,10 0 0,0 12,2M11,17H13V11H11V17Z"/></svg>`;
    }

    el.innerHTML = `${icon}<span>${message}</span>`;
    container.appendChild(el);

    setTimeout(() => {
      el.remove();
    }, 4000);
  };

  async function uploadFileAndUpdateNode(file, nodeId) {
    if (!file || !file.type.startsWith('image/')) {
      showToast('File must be an image', 'error');
      return;
    }
    const node = _nodes.find(n => n.id === nodeId);
    if (!node) return;

    const formData = new FormData();
    formData.append('file', file);

    try {
      showToast('Uploading image...', 'info');
      const res = await fetch('/api/upload-image', {
        method: 'POST',
        body: formData
      });
      const data = await res.json();
      if (data.success) {
        node.properties.image_path = data.path;
        showToast('Image uploaded successfully', 'success');
        refreshNodeDOM(node);
        saveCanvas();
        refreshConnectedPointers(nodeId);
      } else {
        showToast('Upload failed: ' + data.detail, 'error');
      }
    } catch (e) {
      showToast('Upload error: ' + e.message, 'error');
    }
  }

  // Global paste listener
  document.addEventListener('paste', (e) => {
    if (!_selectedNodeId) return;
    const node = _nodes.find(n => n.id === _selectedNodeId);
    if (node && node.type === 'single_image') {
      const items = e.clipboardData.items;
      for (let i = 0; i < items.length; i++) {
        if (items[i].type.indexOf('image') !== -1) {
          const file = items[i].getAsFile();
          uploadFileAndUpdateNode(file, _selectedNodeId);
          break;
        }
      }
    }
  });

  function showModelSettingsModal(node, onModalSaveCallback) {
    const existing = document.getElementById('ai-model-settings-modal');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'ai-model-settings-modal';
    overlay.className = 'modal-overlay';
    
    const box = document.createElement('div');
    box.className = 'modal-box';
    
    // Header
    const header = document.createElement('div');
    header.className = 'modal-header';
    header.innerHTML = `
      <h3>AI Model Settings</h3>
      <button class="modal-close">&times;</button>
    `;
    header.querySelector('.modal-close').onclick = () => overlay.remove();
    box.appendChild(header);

    // Body
    const body = document.createElement('div');
    body.className = 'modal-body';
    box.appendChild(body);
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    const renderModalContent = () => {
      body.innerHTML = '';

      // 1. Endpoint selection & Refresh list
      const endpointSection = document.createElement('div');
      endpointSection.style.cssText = 'display:flex; flex-direction:column; gap:6px;';
      endpointSection.innerHTML = `
        <span class="modal-section-title">Active Endpoint</span>
        <div style="display:flex; gap:6px; align-items:center;">
          <select id="modal-endpoint-select" class="field-input" style="flex:1; width:0; min-width:0;"></select>
          <button id="modal-endpoint-refresh" class="btn btn-secondary" style="padding:6px 12px; font-size:0.75rem;">Refresh Models</button>
        </div>
      `;
      const selectEndpoint = endpointSection.querySelector('#modal-endpoint-select');
      const refreshBtn = endpointSection.querySelector('#modal-endpoint-refresh');

      // Populate endpoints dropdown
      _aiEndpoints.forEach(ep => {
        const opt = document.createElement('option');
        opt.value = ep.name;
        opt.textContent = ep.name;
        selectEndpoint.appendChild(opt);
      });

      // Handle refresh models list from active endpoint
      refreshBtn.onclick = async () => {
        const epName = selectEndpoint.value;
        const ep = _aiEndpoints.find(e => e.name === epName);
        if (!ep) {
          showToast('No active endpoint selected.', 'error');
          return;
        }

        refreshBtn.disabled = true;
        refreshBtn.textContent = 'Pulling...';
        showToast(`Pulling models from ${epName}...`, 'info');

        try {
          const r = await fetch('/api/ai-decision/check-endpoint', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: ep.url, api_key: ep.api_key })
          });
          const d = await r.json();
          if (r.ok && d.success) {
            _aiModels = d.models || [];
            await saveAiConfig();
            showToast(`Pulled ${d.models.length} models successfully!`, 'success');
            onModalSaveCallback();
            renderModalContent();
          } else {
            showToast('Failed to pull models: ' + (d.detail || d.error), 'error');
          }
        } catch (err) {
          showToast('Error checking endpoint: ' + err.message, 'error');
        } finally {
          refreshBtn.disabled = false;
          refreshBtn.textContent = 'Refresh Models';
        }
      };
      body.appendChild(endpointSection);

      // 2. Models list
      const modelsSection = document.createElement('div');
      modelsSection.style.cssText = 'display:flex; flex-direction:column; gap:6px; flex:1; min-height:120px;';
      modelsSection.innerHTML = `
        <span class="modal-section-title">Available Models (${_aiModels.length})</span>
        <div id="modal-models-list" style="flex:1; overflow-y:auto; max-height:200px; border:1px solid var(--border); border-radius:8px; padding:6px; background:rgba(10,15,26,0.3);"></div>
      `;
      const modelsListContainer = modelsSection.querySelector('#modal-models-list');
      if (_aiModels.length === 0) {
        modelsListContainer.innerHTML = '<div style="color:var(--text-muted); font-size:0.75rem; text-align:center; padding:12px;">No models in active list. Refresh an endpoint or add one.</div>';
      } else {
        _aiModels.forEach(m => {
          const row = document.createElement('div');
          row.className = 'model-item-row';
          row.innerHTML = `
            <span style="font-size:0.78rem;">${m}</span>
            <button class="model-delete-btn" title="Delete Model">&times;</button>
          `;
          row.querySelector('.model-delete-btn').onclick = async () => {
            _aiModels = _aiModels.filter(item => item !== m);
            await saveAiConfig();
            onModalSaveCallback();
            renderModalContent();
          };
          modelsListContainer.appendChild(row);
        });
      }
      body.appendChild(modelsSection);

      // 3. Add Endpoint section
      const addEndpointSection = document.createElement('div');
      addEndpointSection.style.cssText = 'border-top:1px solid var(--border); padding-top:12px; display:flex; flex-direction:column; gap:8px;';
      addEndpointSection.innerHTML = `
        <span class="modal-section-title">Add / Edit Endpoint</span>
        <input type="text" id="ep-name" class="field-input" placeholder="Endpoint Name (e.g. OpenAI, Ollama)" style="width:100%; box-sizing:border-box;" />
        <input type="text" id="ep-url" class="field-input" placeholder="Endpoint URL (e.g. http://localhost:11434)" style="width:100%; box-sizing:border-box;" />
        <input type="password" id="ep-key" class="field-input" placeholder="API Key (optional)" style="width:100%; box-sizing:border-box;" />
        <div style="display:flex; gap:6px; margin-top:4px;">
          <button id="btn-check-ep" class="btn btn-secondary" style="flex:1; padding:6px; font-size:0.75rem;">Check & Retrieve Models</button>
          <button id="btn-save-ep" class="btn" style="flex:1; padding:6px; font-size:0.75rem; background:var(--accent);">Save Endpoint</button>
        </div>
      `;
      const epNameInput = addEndpointSection.querySelector('#ep-name');
      const epUrlInput = addEndpointSection.querySelector('#ep-url');
      const epKeyInput = addEndpointSection.querySelector('#ep-key');
      const checkEpBtn = addEndpointSection.querySelector('#btn-check-ep');
      const saveEpBtn = addEndpointSection.querySelector('#btn-save-ep');

      let retrievedModels = [];

      checkEpBtn.onclick = async () => {
        const url = epUrlInput.value.trim();
        const api_key = epKeyInput.value.trim();
        if (!url) {
          showToast('Endpoint URL is required to check.', 'error');
          return;
        }

        checkEpBtn.disabled = true;
        checkEpBtn.textContent = 'Checking...';
        showToast('Connecting to endpoint...', 'info');

        try {
          const r = await fetch('/api/ai-decision/check-endpoint', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url, api_key })
          });
          const d = await r.json();
          if (r.ok && d.success) {
            retrievedModels = d.models || [];
            showToast(`Success! Found ${retrievedModels.length} models. Click Save to store this endpoint and overwrite models list.`, 'success');
          } else {
            showToast('Endpoint check failed: ' + (d.detail || d.error), 'error');
          }
        } catch (err) {
          showToast('Endpoint error: ' + err.message, 'error');
        } finally {
          checkEpBtn.disabled = false;
          checkEpBtn.textContent = 'Check & Retrieve Models';
        }
      };

      let editingEndpointIdx = null;

      saveEpBtn.onclick = async () => {
        const name = epNameInput.value.trim();
        const url = epUrlInput.value.trim();
        const api_key = epKeyInput.value.trim();

        if (!name || !url) {
          showToast('Name and Endpoint URL are required.', 'error');
          return;
        }

        const epData = { name, url, api_key };
        
        if (editingEndpointIdx !== null && editingEndpointIdx >= 0 && editingEndpointIdx < _aiEndpoints.length) {
          _aiEndpoints[editingEndpointIdx] = epData;
          editingEndpointIdx = null;
        } else {
          const existingEpIdx = _aiEndpoints.findIndex(e => e.name === name);
          if (existingEpIdx !== -1) {
            _aiEndpoints[existingEpIdx] = epData;
          } else {
            _aiEndpoints.push(epData);
          }
        }

        // Overwrite active models list if we retrieved models during check
        if (retrievedModels.length > 0) {
          _aiModels = retrievedModels;
        }

        await saveAiConfig();
        showToast('Endpoint saved successfully!', 'success');
        onModalSaveCallback();
        renderModalContent();
      };

      body.appendChild(addEndpointSection);

      // 4. Endpoint List section (below Add / Edit Endpoint)
      const endpointsSection = document.createElement('div');
      endpointsSection.style.cssText = 'border-top:1px solid var(--border); padding-top:12px; display:flex; flex-direction:column; gap:8px;';
      endpointsSection.innerHTML = `
        <span class="modal-section-title">Endpoint List (${_aiEndpoints.length})</span>
        <div id="modal-endpoints-list" style="max-height:160px; overflow-y:auto; border:1px solid var(--border); border-radius:8px; padding:6px; background:rgba(10,15,26,0.3); min-height:60px;"></div>
      `;
      const endpointsListContainer = endpointsSection.querySelector('#modal-endpoints-list');
      if (_aiEndpoints.length === 0) {
        endpointsListContainer.innerHTML = '<div style="color:var(--text-muted); font-size:0.75rem; text-align:center; padding:12px;">Belum ada endpoint tersimpan.</div>';
      } else {
        _aiEndpoints.forEach((ep, idx) => {
          const row = document.createElement('div');
          row.className = 'endpoint-item';
          row.style.cssText = 'display:flex; justify-content:space-between; align-items:center; background:rgba(10, 15, 26, 0.4); border:1px solid var(--border); padding:8px 12px; border-radius:8px; margin-bottom:6px;';
          
          const infoDiv = document.createElement('div');
          infoDiv.style.cssText = 'display:flex; flex-direction:column; gap:2px; overflow:hidden; margin-right:8px;';
          infoDiv.innerHTML = `
            <div style="font-size:0.78rem; font-weight:600; color:var(--text-primary); text-overflow:ellipsis; overflow:hidden; white-space:nowrap;">${ep.name}</div>
            <div style="font-size:0.7rem; color:var(--text-muted); text-overflow:ellipsis; overflow:hidden; white-space:nowrap;">${ep.url}</div>
          `;

          const actionDiv = document.createElement('div');
          actionDiv.style.cssText = 'display:flex; gap:6px; align-items:center; flex-shrink:0;';

          const editBtn = document.createElement('button');
          editBtn.className = 'btn btn-secondary';
          editBtn.style.cssText = 'padding:3px 8px; font-size:0.7rem; border-radius:4px; display:inline-flex; align-items:center; gap:4px;';
          editBtn.innerHTML = '✏️ Edit';
          editBtn.title = 'Edit Endpoint';
          editBtn.onclick = () => {
            editingEndpointIdx = idx;
            epNameInput.value = ep.name;
            epUrlInput.value = ep.url;
            epKeyInput.value = ep.api_key || '';
            saveEpBtn.textContent = 'Update Endpoint';
            epNameInput.focus();
            showToast(`Editing endpoint '${ep.name}'`, 'info');
          };

          const delBtn = document.createElement('button');
          delBtn.className = 'model-delete-btn';
          delBtn.style.cssText = 'padding:2px 6px; font-size:1.1rem; border:none; background:none; color:#ef4444; cursor:pointer; font-weight:bold; line-height:1;';
          delBtn.innerHTML = '&times;';
          delBtn.title = 'Hapus Endpoint';
          delBtn.onclick = async () => {
            if (confirm(`Hapus endpoint '${ep.name}'?`)) {
              _aiEndpoints.splice(idx, 1);
              await saveAiConfig();
              showToast(`Endpoint '${ep.name}' berhasil dihapus.`, 'success');
              onModalSaveCallback();
              renderModalContent();
            }
          };

          actionDiv.append(editBtn, delBtn);
          row.append(infoDiv, actionDiv);
          endpointsListContainer.appendChild(row);
        });
      }
      body.appendChild(endpointsSection);
    };

    renderModalContent();
  }

  // Run initial loading
  window.addEventListener('DOMContentLoaded', init);
})();
