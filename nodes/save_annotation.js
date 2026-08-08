(function() {
  window.NodeDefaults.save_annotation = {
    output_dir: '',
    last_logs: null
  };

  window.NodeRenderers.save_annotation = function(node, body, el) {
    const pins = window.App.createPinsLayout(node,
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
      window.App.saveCanvas();
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
          window.App.saveCanvas();
          window.App.showToast('Folder selected: ' + d.path, 'success');
        } else if (d.message) {
          window.App.showToast(d.message, 'info');
        }
      } catch (err) {
        window.App.showToast('Failed to select folder: ' + err.message, 'error');
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
  };
})();
