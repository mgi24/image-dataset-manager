(function() {
  window.NodeDefaults.ai_decision = {
    model: '',
    class_rules: {
      'semua mobil kecil, minibus, termasuk mobil bak terbuka, kecualikan mobil dengan box bak tertutup.': '0'
    },
    global_rules: 'anda adalah manager dataset yang bertugas decide hasil dari deteksi sudah benar atau belum, compare mana yang bagus maskingnya, output json.',
    global_rules_height: 90,
    node_width: null,
    last_chat_history: [],
    chat_height: 250
  };

  function generateAiPromptPreviewText(node) {
    let rawPrompt = (node.properties.global_rules || '').trim();
    if (!rawPrompt) {
      rawPrompt = `System Prompt: Evaluasi pasangan anotasi terdeteksi dan pilih hasil yang paling tepat.\n\nClass Rules:\n{class_rules}\n\nAvailable Classes: {class}\n\nConflict Inputs:\n{image_input}`;
    }

    const classRulesMap = node.properties.class_rules || {};
    const inputClasses = window.App.getAiDecisionInputClasses(node.id);
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

    let classesStr = '';
    if (inputClasses.length > 0) {
      classesStr = inputClasses.map((c, idx) => `[${idx}: ${c.name}]`).join(', ');
    } else {
      classesStr = '[0: car], [1: truck], [2: bus], [3: motorcycle]';
    }

    const sampleImageInput = `image 1: car\nimage 2: truck\nimage 3: truck`;

    let preview = rawPrompt;
    preview = preview.replace(/\{class_rules\}/g, classRulesStr);
    preview = preview.replace(/\{class\}/g, classesStr);
    preview = preview.replace(/\{image_input\}/g, sampleImageInput);

    return preview;
  }

  window.App.updateAiPromptPreview = function(nodeId) {
    const previewBox = document.getElementById(`ai-prompt-preview-${nodeId}`);
    if (!previewBox) return;
    const node = window.App.getNodes().find(n => n.id === nodeId);
    if (!node) return;
    previewBox.textContent = generateAiPromptPreviewText(node);
  };

  window.App.renderChatHistory = function(nodeId) {
    const container = document.getElementById(`chat-container-${nodeId}`);
    if (!container) return;

    const node = window.App.getNodes().find(n => n.id === nodeId);
    if (!node) return;

    const history = node.properties.last_chat_history || [];
    container.innerHTML = '';

    if (history.length === 0) {
      const placeholder = document.createElement('div');
      placeholder.style.cssText = 'color:var(--text-muted); font-size:0.75rem; text-align:center; padding:20px; font-style:italic;';
      placeholder.textContent = 'Belum ada riwayat percakapan AI.';
      container.appendChild(placeholder);
      return;
    }

    history.forEach(msg => {
      const bubble = document.createElement('div');
      bubble.className = `chat-bubble ${msg.role || 'assistant'}`;
      bubble.style.marginBottom = '8px';

      const label = document.createElement('span');
      label.className = 'chat-bubble-label';
      label.textContent = msg.role === 'user' ? 'Prompt' : (msg.role === 'error' ? 'Parsing Error Report' : 'AI Assistant');
      bubble.appendChild(label);

      const txt = document.createElement('div');
      txt.style.cssText = 'white-space:pre-wrap; word-break:break-word;';
      txt.textContent = msg.content || '';
      bubble.appendChild(txt);

      if (msg.role === 'user' && Array.isArray(msg.images) && msg.images.length > 0) {
        const row = document.createElement('div');
        row.className = 'chat-candidate-row';

        msg.images.forEach((imgB64, idx) => {
          const item = document.createElement('div');
          item.className = 'chat-candidate-item';

          const img = document.createElement('img');
          img.className = 'chat-candidate-img';
          img.src = `data:image/jpeg;base64,${imgB64}`;
          img.draggable = false;

          const num = document.createElement('span');
          num.className = 'chat-candidate-num';
          num.textContent = `Image ${idx + 1}`;

          item.append(img, num);
          row.appendChild(item);
        });
        bubble.appendChild(row);
      }

      container.appendChild(bubble);
    });

    container.scrollTop = container.scrollHeight;
  };

  window.App.refreshAiDecisionRules = async function(nodeId) {
    const rulesList = document.getElementById(`rules-list-${nodeId}`);
    if (!rulesList) return;

    const node = window.App.getNodes().find(n => n.id === nodeId);
    if (!node) return;

    if (typeof node.properties.class_rules === 'string') {
      const oldStr = node.properties.class_rules;
      node.properties.class_rules = {};
      if (oldStr.trim() !== '') {
        node.properties.class_rules[oldStr] = '0';
      }
      window.App.saveCanvas();
    }

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
      window.App.refreshAiDecisionRules(nodeId);
      window.App.saveCanvas();
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
      ruleInput.disabled = true;
      ruleInput.style.cssText = 'width:100%; min-height:36px; font-size:0.72rem; padding:4px 8px; resize:vertical; box-sizing:border-box; background:transparent; border:none; color:var(--text-primary); font-family:inherit; outline:none; cursor:default;';

      const editRow = document.createElement('div');
      editRow.style.cssText = 'display:flex; gap:6px; align-items:center;';

      const select = document.createElement('select');
      select.className = 'binding-select';
      select.style.cssText = 'flex:1; font-size:0.72rem; padding:4px;';
      select.disabled = true;
      inputClasses.forEach((c, idx) => {
        const opt = document.createElement('option');
        opt.value = idx; opt.textContent = c.name;
        select.appendChild(opt);
      });
      select.value = rules[rText];
      select.onchange = () => {
        node.properties.class_rules[currentKey] = select.value;
        window.App.saveCanvas();
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
            window.App.refreshAiDecisionRules(nodeId);
            window.App.saveCanvas();
            return;
          }
          ruleInput.disabled = true;
          select.disabled = true;
          ruleInput.style.border = 'none';
          ruleInput.style.background = 'transparent';
          ruleInput.style.cursor = 'default';
          editBtn.textContent = '✏️';
          editBtn.title = 'Edit Rule';
          window.App.saveCanvas();
        }
      };

      editBtn.onclick = (e) => {
        e.preventDefault();
        toggleEdit();
      };

      delBtn.onclick = () => {
        delete node.properties.class_rules[currentKey];
        window.App.refreshAiDecisionRules(nodeId);
        window.App.saveCanvas();
      };

      editRow.append(select, editBtn, delBtn);
      row.append(ruleInput, editRow);
      rulesList.appendChild(row);
    });
  };

  window.NodeRenderers.ai_decision = function(node, body, el) {
    const pins = window.App.createPinsLayout(node, 
      [
        { name: 'worker_input', label: 'Worker Input' }
      ],
      [
        { name: 'worker_output', label: 'Worker Output' }
      ]
    );
    body.appendChild(pins);

    // Model selector
    const modelGroup = document.createElement('div');
    modelGroup.className = 'field-group';
    modelGroup.innerHTML = `
      <span class="field-label">AI Model</span>
      <div style="display:flex; gap:6px; align-items:center;">
        <select id="model-select-${node.id}" class="field-input" style="flex:1; width:0; min-width:0;"></select>
        <button id="settings-btn-${node.id}" class="ai-decision-settings-btn" title="Model Settings">
          <svg viewBox="0 0 24 24" style="width:16px;height:16px;fill:currentColor">
            <path d="M12,15.5A3.5,3.5 0 0,1 8.5,12A3.5,3.5 0 0,1 12,8.5A3.5,3.5 0 0,1 15.5,12A3.5,3.5 0 0,1 12,15.5M19.43,12.97C19.47,12.65 19.5,12.33 19.5,12C19.5,11.67 19.47,11.34 19.43,11L21.54,9.37C21.73,9.22 21.78,8.95 21.66,8.73L19.66,5.27C19.54,5.05 19.27,4.96 19.05,5.05L16.56,6.05C16.04,5.66 15.47,5.34 14.86,5.08L14.47,2.42C14.43,2.18 14.22,2 13.97,2H9.97C9.72,2 9.51,2.18 9.47,2.42L9.08,5.08C8.47,5.34 7.9,5.66 7.38,6.05L4.89,5.05C4.67,4.96 4.4,5.05 4.27,5.27L2.27,8.73C2.15,8.95 2.2,9.22 2.4,9.37L4.5,11C4.47,11.34 4.45,11.67 4.45,12C4.45,12.33 4.47,12.65 4.45,12C4.45,12.33 4.47,12.65 4.5,13L2.4,14.63C2.2,14.78 2.15,15.05 2.27,15.27L4.27,18.73C4.40,18.95 4.67,19.04 4.89,18.95L7.38,17.95C7.9,18.34 8.47,18.66 9.08,18.92L9.47,21.58C9.51,21.82 9.72,22 9.97,22H13.97C14.22,22 14.43,21.82 14.47,21.58L14.86,18.92C15.47,18.66 16.04,18.34 16.56,17.95L19.05,18.95C19.27,19.04 19.54,18.95 19.66,18.73L21.66,15.27C21.78,15.05 21.73,14.78 21.54,14.63L19.43,12.97Z"/>
          </svg>
        </button>
      </div>
    `;
    const selectEl = modelGroup.querySelector('select');
    const settingsBtn = modelGroup.querySelector('button');

    const populateModels = () => {
      selectEl.innerHTML = '';
      window.App.getAiModels().forEach(m => {
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
      window.App.saveCanvas();
    };
    
    settingsBtn.onclick = () => {
      window.App.showModelSettingsModal(node, populateModels);
    };
    body.appendChild(modelGroup);

    // Class Rules
    const rulesGroup = document.createElement('div');
    rulesGroup.className = 'field-group';
    rulesGroup.innerHTML = `
      <span class="field-label">Class Rules Bindings</span>
      <div style="font-size:0.68rem; color:var(--text-muted); margin:3px 0 6px 0; line-height:1.4;">
        Tag placeholder yang tersedia:<br/>
        <code style="color:#34d399; background:rgba(255,255,255,0.06); padding:1px 4px; border-radius:3px;">&#123;class_rules&#125;</code>: Daftar aturan kelas binding<br/>
        <code style="color:#38bdf8; background:rgba(255,255,255,0.06); padding:1px 4px; border-radius:3px;">&#123;class&#125;</code>: Daftar kelas yang tersedia
      </div>
      <div id="rules-list-${node.id}" style="display:flex; flex-direction:column; gap:6px; margin-top:4px;"></div>
      <div id="class-list-container-${node.id}" style="margin-top:10px; border-top:1px solid rgba(255,255,255,0.06); padding-top:8px;"></div>
    `;
    body.appendChild(rulesGroup);

    // Global Rules
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

    if (node.properties.node_width) {
      el.style.width = node.properties.node_width + 'px';
    }
    el.onmouseup = () => {
      if (el.clientWidth) {
        node.properties.node_width = el.clientWidth;
        window.App.saveCanvas();
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
        window.App.saveCanvas();
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
        window.App.saveCanvas();
      }
    };

    txtArea.value = node.properties.global_rules || '';
    txtArea.oninput = () => {
      globalSaveBtn.style.display = 'inline-flex';
      if (previewBox.style.display !== 'none') {
        window.App.updateAiPromptPreview(node.id);
      }
    };
    
    globalSaveBtn.onclick = (e) => {
      e.preventDefault();
      node.properties.global_rules = txtArea.value;
      window.App.saveCanvas();
      globalSaveBtn.style.display = 'none';
      window.App.showToast('Global rules saved!', 'success');
      if (previewBox.style.display !== 'none') {
        window.App.updateAiPromptPreview(node.id);
      }
    };

    toggleBtn.onclick = (e) => {
      e.preventDefault();
      const isHidden = previewBox.style.display === 'none';
      if (isHidden) {
        window.App.updateAiPromptPreview(node.id);
        previewBox.style.display = 'block';
        toggleBtn.innerHTML = '👁️ Hide Preview';
      } else {
        previewBox.style.display = 'none';
        toggleBtn.innerHTML = '👁️ Show Preview';
      }
    };

    body.appendChild(globalGroup);

    // Resizable Chat Console
    const chatContainer = document.createElement('div');
    chatContainer.className = 'ai-chat-container resizable-box';
    chatContainer.id = `chat-container-${node.id}`;
    chatContainer.style.cssText = `height:${node.properties.chat_height || 250}px; overflow-y:auto;`;
    
    if (node.properties.preview_width) {
      chatContainer.style.width = node.properties.preview_width + 'px';
    }
    chatContainer.onmouseup = () => {
      if (chatContainer.clientHeight) {
        node.properties.chat_height = chatContainer.clientHeight;
      }
      if (chatContainer.clientWidth) {
        node.properties.preview_width = chatContainer.clientWidth;
      }
      window.App.saveCanvas();
    };
    
    body.appendChild(chatContainer);
    setTimeout(() => {
      window.App.renderChatHistory(node.id);
      window.App.refreshAiDecisionRules(node.id);
    }, 0);
  };
})();
