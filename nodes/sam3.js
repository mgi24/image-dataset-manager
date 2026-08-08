(function() {
  window.NodeDefaults.sam3 = {
    model: 'sam3.pt',
    imgsz: 640,
    conf: 0.25,
    verbose: false,
    device: window.App.getCachedGpus()[0]?.id || 'cuda:0',
    prompt_bindings: {},
    last_preview: null,
    last_logs: null,
    preview_width: 280,
    preview_height: 140
  };

  window.App.refreshSam3Bindings = async function(nodeId) {
    const bindingList = document.getElementById(`binding-list-${nodeId}`);
    if (!bindingList) return;

    const node = window.App.getNodes().find(n => n.id === nodeId);
    if (!node) return;

    let connectedClassSourceNode = null;
    for (const conn of window.App.getConnections()) {
      if (conn.toNodeId === nodeId && conn.toPinName === 'class') {
        const fromNode = window.App.getNodes().find(n => n.id === conn.fromNodeId);
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
      window.App.refreshSam3Bindings(nodeId);
      window.App.saveCanvas();
    };

    addForm.append(promptInp, classSel, addBtn);
    bindingList.appendChild(addForm);

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
        window.App.saveCanvas();
      };

      const delBtn = document.createElement('button');
      delBtn.className = 'node-close-btn';
      delBtn.textContent = '×';
      delBtn.style.fontSize = '0.9rem';
      delBtn.style.padding = '0 4px';
      delBtn.onclick = () => {
        delete node.properties.prompt_bindings[pText];
        window.App.refreshSam3Bindings(nodeId);
        window.App.saveCanvas();
      };

      row.append(label, select, delBtn);
      bindingList.appendChild(row);
    });
  };

  window.NodeRenderers.sam3 = function(node, body, el) {
    const pins = window.App.createPinsLayout(node, 
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

    // 1. Model Selection
    const modelGroup = document.createElement('div');
    modelGroup.className = 'field-group';
    modelGroup.innerHTML = `<span class="field-label">SAM3 Model</span>`;
    const modelSel = document.createElement('select');
    modelSel.className = 'field-input';
    
    const samModels = window.App.getCachedModels().filter(m => m.toLowerCase().includes('sam'));
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
      window.App.saveCanvas();
      window.App.refreshSam3Bindings(node.id);
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
    setTimeout(() => window.App.refreshSam3Bindings(node.id), 0);
  };
})();
