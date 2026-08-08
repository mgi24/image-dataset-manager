(function() {
  window.NodeDefaults.overlap_comparator = {
    input_pins: ['image', 'class', 'annotation1', 'annotation2'],
    iou_threshold: 0.5,
    comparator_rules: [],
    last_preview: null,
    preview_width: 320,
    preview_height: 240
  };

  window.NodeRenderers.overlap_comparator = function(node, body, el) {
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
    const pins = window.App.createPinsLayout(node, pins_in, pins_out);
    body.appendChild(pins);

    // Comparator Action Section
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
            window.App.saveCanvas();
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
        window.App.showToast('Source dan target annotation harus berbeda.', 'error');
        return;
      }
      if (!node.properties.comparator_rules) node.properties.comparator_rules = [];
      
      node.properties.comparator_rules = node.properties.comparator_rules.filter(r => 
        !( (r.src === sVal && r.target === tVal) || (r.src === tVal && r.target === sVal) )
      );

      node.properties.comparator_rules.push({ src: sVal, target: tVal, action: aVal });
      window.App.saveCanvas();
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
      window.App.saveCanvas();
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
      window.App.saveCanvas();
    };
    body.appendChild(previewContainer);
    setTimeout(() => window.App.renderPreviewContent(node.id, node.properties.last_preview), 0);
  };
})();
