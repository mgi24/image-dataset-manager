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

  // DOM elements
  const canvasWrap = document.getElementById('canvas-wrap');
  const canvasContent = document.getElementById('canvas-content');
  const nodesContainer = document.getElementById('nodes-container');
  const svgOverlay = document.getElementById('node-svg-overlay');

  // Panning State
  let _panX = 0;
  let _panY = 0;
  let _isPanning = false;
  let _startPanMouseX = 0;
  let _startPanMouseY = 0;
  let _startPanX = 0;
  let _startPanY = 0;

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

    // Load saved canvas layout
    await loadCanvas();

    // Restore pan state
    _panX = parseFloat(localStorage.getItem('annodes_pan_x')) || 0;
    _panY = parseFloat(localStorage.getItem('annodes_pan_y')) || 0;
    canvasContent.style.transform = `translate(${_panX}px, ${_panY}px)`;

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

    // Mouse move/up listeners for connection drawing
    document.addEventListener('mousemove', onDocumentMouseMove);
    document.addEventListener('mouseup', onDocumentMouseUp);

    // Initial render
    renderAll();
  }

  // --- API Fetchers ---
  async function fetchModels() {
    try {
      const r = await fetch('/api/models');
      const d = await r.json();
      if (d.success) _cachedModels = d.models || [];
    } catch (e) { console.warn('Failed to fetch models', e); }
  }

  async function fetchGpus() {
    try {
      const r = await fetch('/api/gpus');
      const d = await r.json();
      if (d.success) _cachedGpus = d.gpus || [];
    } catch (e) { console.warn('Failed to fetch GPUs', e); }
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
      } else if (type === 'preview') {
        properties = {
          last_preview: null,
          preview_width: 280,
          preview_height: 140
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
    } else {
      // Refresh connected YOLO nodes
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
      inCol.appendChild(row);
    });

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

  // --- Rendering Nodes DOM ---
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

    const closeBtn = document.createElement('button');
    closeBtn.className = 'node-close-btn';
    closeBtn.textContent = '✕';
    closeBtn.title = 'Hapus Node';
    closeBtn.onclick = (e) => { e.stopPropagation(); deleteNode(node.id); };

    header.append(title, closeBtn);

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
        }),
        createInputField('Annotation Path (.txt)', 'text', node.properties.annotation_path, (v) => {
          node.properties.annotation_path = v;
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
      _cachedModels.forEach(m => {
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
      previewPlaceholder.textContent = 'No Ground Truth/Predicted Preview';
      
      const previewImg = document.createElement('img');
      previewImg.className = 'preview-img';
      previewImg.id = `preview-img-${node.id}`;
      previewImg.style.display = 'none';
      if (node.properties.last_preview) {
        previewImg.src = `data:image/jpeg;base64,${node.properties.last_preview}`;
        previewImg.style.display = 'block';
        previewPlaceholder.style.display = 'none';
      }
      
      previewContainer.append(previewPlaceholder, previewImg);
      body.appendChild(previewContainer);
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

  function refreshAllYoloBindings() {
    _nodes.forEach(n => {
      if (n.type === 'yolo_detector') {
        refreshYoloBindings(n.id);
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
      startX: pinRect.left + pinRect.width/2 - contentRect.left,
      startY: pinRect.top + pinRect.height/2 - contentRect.top,
      mouseX: pinRect.left + pinRect.width/2 - contentRect.left,
      mouseY: pinRect.top + pinRect.height/2 - contentRect.top
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

      const fx = fromRect.left + fromRect.width/2 - contentRect.left;
      const fy = fromRect.top + fromRect.height/2 - contentRect.top;
      const tx = toRect.left + toRect.width/2 - contentRect.left;
      const ty = toRect.top + toRect.height/2 - contentRect.top;

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
      canvasContent.style.transform = `translate(${_panX}px, ${_panY}px)`;
    }

    // Handling Node Dragging
    if (_dragNodeState) {
      // Delta mouse movements must not be scaled by canvas translation offsets, 
      // but should remain absolute values in pixels.
      const dx = e.clientX - _dragNodeState.startX;
      const dy = e.clientY - _dragNodeState.startY;
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
      _draftConn.mouseX = e.clientX - contentRect.left;
      _draftConn.mouseY = e.clientY - contentRect.top;
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
          
          // Re-render and trigger bindings config if connected to YOLO class
          renderAll(); 
          if (toNodeId) {
            refreshYoloBindings(toNodeId);
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
      }
    } catch (e) {
      console.warn('Failed to load canvas', e);
      showToast('Gagal memuat canvas dari DB', 'error');
    }
  }

  // --- Execute Flow (Run Flow) ---
  window.runFlow = async function () {
    showToast('Menjalankan flow auto-annotation...', 'info');
    
    // Auto save layout before execution
    await saveCanvas();

    try {
      const r = await fetch('/api/run-flow', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          nodes: _nodes,
          connections: _connections
        })
      });
      
      const d = await r.json();
      if (r.ok && d.success) {
        showToast(`Berhasil memproses: ${d.filename || ''}`, 'success');
        
        // Loop over the previews returned by backend to update node image containers
        if (d.previews) {
          Object.keys(d.previews).forEach(nodeId => {
            const node = _nodes.find(n => n.id === nodeId);
            if (node) {
              const base64 = d.previews[nodeId];
              node.properties.last_preview = base64;

              const previewImg = document.getElementById(`preview-img-${nodeId}`);
              const previewPlaceholder = document.querySelector(`#preview-container-${nodeId} .preview-placeholder`);
              
              if (previewImg && base64) {
                previewImg.src = `data:image/jpeg;base64,${base64}`;
                previewImg.style.display = 'block';
                if (previewPlaceholder) previewPlaceholder.style.display = 'none';
              }
            }
          });
        }

        // Loop over logs returned by backend to update console log outputs
        if (d.logs) {
          Object.keys(d.logs).forEach(nodeId => {
            const node = _nodes.find(n => n.id === nodeId);
            if (node) {
              const logsHtml = d.logs[nodeId];
              node.properties.last_logs = logsHtml;

              const logsConsole = document.getElementById(`yolo-logs-${nodeId}`);
              if (logsConsole) {
                logsConsole.innerHTML = logsHtml;
                logsConsole.scrollTop = logsConsole.scrollHeight;
              }
            }
          });
        }
        
        // Save the updated previews/logs properties to DB
        saveCanvas();

      } else {
        const errorMsg = d.detail || d.error || 'Terjadi kesalahan saat memproses flow.';
        showToast(errorMsg, 'error');
      }
    } catch (e) {
      console.error('Run flow error:', e);
      showToast('Gagal terhubung ke backend server', 'error');
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

  // Run initial loading
  window.addEventListener('DOMContentLoaded', init);
})();
