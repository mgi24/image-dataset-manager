// Annodes JavaScript node editor with Multiple Pins & Resize Observer

(function () {
  window.NodeDefaults = {};
  window.NodeRenderers = {};
  window.App = {
    getNodes: () => _nodes,
    setNodes: (val) => { _nodes = val; },
    getConnections: () => _connections,
    setConnections: (val) => { _connections = val; },
    getCachedModels: () => _cachedModels,
    getCachedGpus: () => _cachedGpus,
    getAiModels: () => _aiModels,
    getAiEndpoints: () => _aiEndpoints,
    getSelectedNodeId: () => _selectedNodeId,
    setSelectedNodeId: (val) => { _selectedNodeId = val; },
    
    saveCanvas: () => saveCanvas(),
    renderConnections: () => renderConnections(),
    createPinsLayout: (node, inputs, outputs) => createPinsLayout(node, inputs, outputs),
    createInputField: (label, type, val, onChange) => createInputField(label, type, val, onChange),
    refreshNodeDOM: (node) => refreshNodeDOM(node),
    refreshAllYoloBindings: () => refreshAllYoloBindings(),
    showToast: (msg, type) => showToast(msg, type),
    runFlow: (runOnlyNodes) => window.runFlow(runOnlyNodes),
    duplicateNode: (nodeId) => duplicateNode(nodeId),
    deleteNode: (nodeId) => deleteNode(nodeId),
    runFlowFromInputNode: (inputId) => runFlowFromInputNode(inputId),
    renderPreviewContent: (nodeId, previewData) => renderPreviewContent(nodeId, previewData),
    refreshConnectedPointers: (sourceNodeId) => refreshConnectedPointers(sourceNodeId),
    uploadFileAndUpdateNode: (file, nodeId) => uploadFileAndUpdateNode(file, nodeId),
    renderClassesList: (node) => renderClassesList(node),
    getAiDecisionInputClasses: (nodeId) => getAiDecisionInputClasses(nodeId),
    showModelSettingsModal: (node, onSave) => showModelSettingsModal(node, onSave),
    renderPointsOverlay: (node) => renderPointsOverlay(node),
    updatePointerNodeImage: (nodeId) => updatePointerNodeImage(nodeId)
  };

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
      const getDefaults = window.NodeDefaults[type];
      if (typeof getDefaults === 'function') {
        properties = getDefaults();
      } else if (getDefaults) {
        properties = JSON.parse(JSON.stringify(getDefaults));
      }
    }

    const node = { id, type, x, y, properties };
    _nodes.push(node);
    
    renderNodeDOM(node);
    saveCanvas();
    
    // If connected inputs exist, we should refresh bindings
    if (type === 'yolo_detector') {
      if (window.App.refreshYoloBindings) window.App.refreshYoloBindings(id);
    } else if (type === 'sam3') {
      if (window.App.refreshSam3Bindings) window.App.refreshSam3Bindings(id);
    } else if (type === 'ai_decision') {
      if (window.App.refreshAiDecisionRules) window.App.refreshAiDecisionRules(id);
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

  function duplicateNode(nodeId) {
    const srcNode = _nodes.find(n => n.id === nodeId);
    if (!srcNode) return;
    
    const clonedProps = JSON.parse(JSON.stringify(srcNode.properties));
    clonedProps.last_chat_history = [];
    clonedProps.last_preview = null;
    clonedProps.last_logs = null;
    clonedProps.is_processing = false;
    clonedProps.paused = false;

    createNode(srcNode.type, srcNode.x + 40, srcNode.y + 40, {
      id: 'node-' + Date.now() + '-' + Math.floor(Math.random()*1000),
      properties: clonedProps
    });
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
      if (node.properties.is_processing && (pin.name.startsWith('worker_output_') || pin.name === 'worker_input')) {
        const pinSpinner = document.createElement('span');
        pinSpinner.className = 'processing-spinner';
        pinSpinner.style.cssText = 'width:6px; height:6px; border:1.5px solid var(--accent); border-top-color:transparent; border-radius:50%; display:inline-block; margin-left:6px; vertical-align:middle;';
        label.appendChild(pinSpinner);
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

    if (node.type === 'overlap_comparator') {
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
      if (node.properties.is_processing && (pin.name.startsWith('worker_input_') || pin.name === 'worker_output')) {
        const pinSpinner = document.createElement('span');
        pinSpinner.className = 'processing-spinner';
        pinSpinner.style.cssText = 'width:6px; height:6px; border:1.5px solid var(--accent); border-top-color:transparent; border-radius:50%; display:inline-block; margin-right:6px; vertical-align:middle;';
        label.prepend(pinSpinner);
      }

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

    if (node.type === 'ai_queueing') {
      const addRow = document.createElement('div');
      addRow.className = 'pin-row';
      addRow.style.cssText = 'padding: 2px 4px; display: flex; gap: 4px; justify-content: flex-end; width: 100%; box-sizing: border-box;';
      
      const addBtn = document.createElement('button');
      addBtn.textContent = '+ Add Worker';
      addBtn.className = 'btn btn-secondary';
      addBtn.style.cssText = 'font-size: 0.65rem; padding: 2px 6px; line-height: 1; border-radius: 4px;';
      addBtn.onclick = (e) => {
        e.stopPropagation();
        node.properties.worker_count = (node.properties.worker_count || 1) + 1;
        saveCanvas();
        refreshNodeDOM(node);
      };

      addRow.appendChild(addBtn);

      if ((node.properties.worker_count || 1) > 1) {
        const delBtn = document.createElement('button');
        delBtn.textContent = '✕';
        delBtn.className = 'btn btn-secondary';
        delBtn.style.cssText = 'font-size: 0.65rem; padding: 2px 6px; line-height: 1; border-radius: 4px; color: #ef4444;';
        delBtn.onclick = (e) => {
          e.stopPropagation();
          const wIdx = node.properties.worker_count || 1;
          _connections = _connections.filter(c => 
            !(c.fromNodeId === node.id && c.fromPinName === `worker_input_${wIdx}`) &&
            !(c.toNodeId === node.id && c.toPinName === `worker_output_${wIdx}`)
          );
          node.properties.worker_count = wIdx - 1;
          saveCanvas();
          refreshNodeDOM(node);
        };
        addRow.appendChild(delBtn);
      }

      outCol.appendChild(addRow);
    }

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

    if (node.type === 'ai_decision') {
      const copyBtn = document.createElement('button');
      copyBtn.className = 'node-close-btn';
      copyBtn.innerHTML = `
        <svg viewBox="0 0 24 24" style="width:12px;height:12px;fill:currentColor;vertical-align:middle;">
          <path d="M16,20H8V6H16M16,4H8C6.89,4 6,4.89 6,6V20C6,21.1 6.89,22 8,22H16C17.1,22 18,21.1 18,20V6C18,4.89 17.1,4 16,4M20,8V2H4V18H6V4H18V8H20Z"/>
        </svg>
      `;
      copyBtn.title = 'Salin (Duplicate) Node';
      copyBtn.onclick = (e) => {
        e.stopPropagation();
        duplicateNode(node.id);
      };
      rightControls.appendChild(copyBtn);
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
    const renderer = window.NodeRenderers[node.type];
    if (renderer) {
      renderer(node, body, el);
    } else {
      console.warn('No renderer registered for node type:', node.type);
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

  function refreshAllYoloBindings() {
    _nodes.forEach(n => {
      if (n.type === 'yolo_detector') {
        if (window.App.refreshYoloBindings) window.App.refreshYoloBindings(n.id);
      } else if (n.type === 'sam3') {
        if (window.App.refreshSam3Bindings) window.App.refreshSam3Bindings(n.id);
      } else if (n.type === 'ai_decision') {
        if (window.App.refreshAiDecisionRules) window.App.refreshAiDecisionRules(n.id);
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
                if (window.App.refreshYoloBindings) window.App.refreshYoloBindings(toNodeId);
              } else if (targetNode.type === 'sam3') {
                if (window.App.refreshSam3Bindings) window.App.refreshSam3Bindings(toNodeId);
              } else if (targetNode.type === 'ai_decision') {
                if (window.App.refreshAiDecisionRules) window.App.refreshAiDecisionRules(toNodeId);
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
    } else if (ev.type === 'chat_history_update') {
      const nodeId = ev.node_id;
      const node = _nodes.find(n => n.id === nodeId);
      if (node) {
        node.properties.last_chat_history = ev.chat_history;
        saveCanvas();
        renderChatHistory(nodeId);
      }
    } else if (ev.type === 'node_state_update') {
      const nodeId = ev.node_id;
      const node = _nodes.find(n => n.id === nodeId);
      if (node) {
        Object.assign(node.properties, ev.properties);
        saveCanvas();
        refreshNodeDOM(node);
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
        // Multi-card container nodes (preview, overlap_comparator, ai_decision, ai_queueing)
        const previewContainer = document.getElementById(`preview-container-${n.id}`);
        if (previewContainer) {
          previewContainer.innerHTML = '<span class="preview-placeholder">Memproses...</span>';
        }
        
        if (n.type === 'ai_decision') {
          n.properties.last_chat_history = [];
          const chatContainer = document.getElementById(`chat-container-${n.id}`);
          if (chatContainer) {
            chatContainer.innerHTML = '<span class="preview-placeholder">Memproses...</span>';
          }
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
