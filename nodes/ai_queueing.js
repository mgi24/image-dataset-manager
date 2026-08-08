(function() {
  window.NodeDefaults.ai_queueing = {
    worker_count: 1,
    max_retries: 3,
    paused: false,
    last_preview: null,
    last_logs: null,
    preview_width: 320,
    preview_height: 180,
    logs_height: 60
  };

  window.NodeRenderers.ai_queueing = function(node, body, el) {
    const wCount = node.properties.worker_count || 1;
    const inputs = [
      { name: 'image', label: 'Image' },
      { name: 'processed_annotation', label: 'Processed annotation' },
      { name: 'original_annotate', label: 'Original annotate', optional: true }
    ];
    for (let i = 1; i <= wCount; i++) {
      inputs.push({ name: `worker_output_${i}`, label: `Worker Output ${i}` });
    }

    const outputs = [
      { name: 'image', label: 'Image' },
      { name: 'annotation', label: 'Annotation' },
      { name: 'failed_image', label: 'Failed Image' },
      { name: 'failed_annotation', label: 'Failed Annotation' }
    ];
    for (let i = 1; i <= wCount; i++) {
      outputs.push({ name: `worker_input_${i}`, label: `Worker Input ${i}` });
    }

    const pins = window.App.createPinsLayout(node, inputs, outputs);
    body.appendChild(pins);

    // Warning label below original_annotate
    const warningText = document.createElement('div');
    warningText.style.cssText = 'color:#f87171; font-size:0.62rem; padding: 2px 8px; line-height: 1.25; margin-bottom: 6px; font-style: italic; border-left: 2px solid #ef4444; background: rgba(239, 68, 68, 0.08); border-radius: 3px;';
    warningText.textContent = 'Warning: Hanya connect original annotate ke node input (jika ada)';
    body.appendChild(warningText);

    // Pause / Resume and settings row
    const ctrlGroup = document.createElement('div');
    ctrlGroup.className = 'field-group';
    ctrlGroup.style.cssText = 'display:flex; flex-direction:column; gap:6px; border:1px solid var(--border); border-radius:6px; padding:8px; background:rgba(255,255,255,0.02);';
    
    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex; gap:6px; align-items:center;';
    
    const pauseBtn = document.createElement('button');
    pauseBtn.className = 'btn';
    pauseBtn.style.cssText = 'flex:1; padding:4px 10px; font-size:0.75rem; display:flex; align-items:center; justify-content:center; gap:6px; font-weight:700;';
    if (node.properties.paused) {
      pauseBtn.innerHTML = '🟢 Resume';
      pauseBtn.style.background = '#10b981';
    } else {
      pauseBtn.innerHTML = '⏸️ Pause';
      pauseBtn.style.background = '#ef4444';
    }
    pauseBtn.onclick = async (e) => {
      e.preventDefault();
      node.properties.paused = !node.properties.paused;
      await window.App.saveCanvas();
      try {
        await fetch('/api/ai-queue/pause-toggle', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ node_id: node.id, paused: node.properties.paused })
        });
      } catch (err) {
        console.warn('Failed to sync pause toggle:', err);
      }
      window.App.refreshNodeDOM(node);
    };

    btnRow.appendChild(pauseBtn);
    
    // Retries input
    const retriesRow = window.App.createInputField('Max Retries', 'number', node.properties.max_retries || 3, (v) => {
      node.properties.max_retries = parseInt(v) || 3;
      window.App.saveCanvas();
    });
    retriesRow.style.cssText = 'flex:1.2; margin:0;';
    
    btnRow.appendChild(retriesRow);
    ctrlGroup.appendChild(btnRow);
    body.appendChild(ctrlGroup);

    // Resizable Preview frame
    const previewContainer = document.createElement('div');
    previewContainer.className = 'preview-container resizable-box';
    previewContainer.id = `preview-container-${node.id}`;
    previewContainer.style.cssText = 'overflow-y: auto; display: flex; flex-direction: column; gap: 4px; padding: 6px; align-items: stretch; justify-content: flex-start; margin-top: 6px;';
    if (node.properties.preview_width) {
      previewContainer.style.width = node.properties.preview_width + 'px';
    }
    if (node.properties.preview_height) {
      previewContainer.style.height = node.properties.preview_height + 'px';
    }
    previewContainer.onmouseup = () => {
      if (previewContainer.clientHeight) {
        node.properties.preview_height = previewContainer.clientHeight;
      }
      if (previewContainer.clientWidth) {
        node.properties.preview_width = previewContainer.clientWidth;
      }
      window.App.saveCanvas();
    };
    
    body.appendChild(previewContainer);

    // Logs console
    const logsConsole = document.createElement('div');
    logsConsole.className = 'yolo-logs-console';
    logsConsole.id = `yolo-logs-${node.id}`;
    logsConsole.style.cssText = 'height:60px; font-family:monospace; font-size:0.7rem; background:#070a13; border:1px solid var(--border); border-radius:6px; padding:6px; color:#34d399; overflow-y:auto; box-sizing:border-box; margin-top:4px; font-weight:normal; line-height:1.2; resize:vertical;';
    if (node.properties.logs_height) {
      logsConsole.style.height = node.properties.logs_height + 'px';
      logsConsole.style.maxHeight = 'none';
    }
    logsConsole.onmouseup = () => {
      if (logsConsole.clientHeight) {
        node.properties.logs_height = logsConsole.clientHeight;
        window.App.saveCanvas();
      }
    };
    logsConsole.innerHTML = node.properties.last_logs || '<div style="color:var(--text-muted);">No logs available. Run flow to see output.</div>';
    
    body.appendChild(logsConsole);
    
    if (node.properties.node_width) {
      el.style.width = node.properties.node_width + 'px';
    }
    el.onmouseup = () => {
      if (el.clientWidth) {
        node.properties.node_width = el.clientWidth;
        window.App.saveCanvas();
      }
    };
    
    setTimeout(() => {
      window.App.renderPreviewContent(node.id, node.properties.last_preview);
    }, 0);
  };
})();
