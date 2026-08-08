(function() {
  window.NodeDefaults.yolo_detector = function() {
    return {
      model: window.App.getCachedModels()[0] || 'yolov8x-seg.pt',
      imgsz: 640,
      conf: 0.25,
      verbose: false,
      device: window.App.getCachedGpus()[0]?.id || 'cuda:0',
      class_bindings: {},
      last_preview: null,
      last_logs: null,
      preview_width: 280,
      preview_height: 140
    };
  };

  window.App.refreshYoloBindings = async function(yoloNodeId) {
    const bindingList = document.getElementById(`binding-list-${yoloNodeId}`);
    if (!bindingList) return;

    const yoloNode = window.App.getNodes().find(n => n.id === yoloNodeId);
    if (!yoloNode) return;

    let connectedClassSourceNode = null;
    for (const conn of window.App.getConnections()) {
      if (conn.toNodeId === yoloNodeId && conn.toPinName === 'class') {
        const fromNode = window.App.getNodes().find(n => n.id === conn.fromNodeId);
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

        const currentBindingVal = yoloNode.properties.class_bindings[mIdx];
        if (currentBindingVal !== undefined && currentBindingVal !== "") {
          select.value = currentBindingVal;
        }

        select.onchange = () => {
          yoloNode.properties.class_bindings[mIdx] = select.value;
          window.App.saveCanvas();
        };

        row.append(label, select);
        bindingList.appendChild(row);
      });
    } catch (e) {
      bindingList.innerHTML = `<span style="font-size:0.72rem; color:#ef4444;">Error memuat class model</span>`;
    }
  };

  window.NodeRenderers.yolo_detector = function(node, body, el) {
    const pins = window.App.createPinsLayout(node, 
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
    const yoloModels = window.App.getCachedModels().filter(m => !m.toLowerCase().includes('sam'));
    if (!yoloModels.includes('platLarge.pt')) {
      yoloModels.unshift('platLarge.pt');
    }
    if (!node.properties.model) {
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
      window.App.saveCanvas();
      window.App.refreshYoloBindings(node.id);
    };
    modelGroup.appendChild(modelSel);

    // 2. Imgsz input
    const imgszRow = window.App.createInputField('Image Size (imgsz)', 'number', node.properties.imgsz, (v) => {
      node.properties.imgsz = parseInt(v) || 640;
      window.App.saveCanvas();
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
      window.App.saveCanvas();
    };

    // 4. Verbose checkbox
    const verboseRow = document.createElement('div');
    verboseRow.style.cssText = 'display:flex; align-items:center; gap:8px;';
    const verboseChk = document.createElement('input');
    verboseChk.type = 'checkbox';
    verboseChk.checked = !!node.properties.verbose;
    verboseChk.onchange = () => {
      node.properties.verbose = verboseChk.checked;
      window.App.saveCanvas();
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
    window.App.getCachedGpus().forEach(g => {
      const o = document.createElement('option');
      o.value = g.id; o.textContent = g.name;
      if (g.id === node.properties.device) o.selected = true;
      gpuSel.appendChild(o);
    });
    gpuSel.onchange = () => {
      node.properties.device = gpuSel.value;
      window.App.saveCanvas();
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
      window.App.saveCanvas();
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
    setTimeout(() => window.App.refreshYoloBindings(node.id), 0);
  };
})();
