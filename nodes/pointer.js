(function() {
  window.NodeDefaults.pointer = {
    points: [],
    active_mode: 'positive',
    last_preview: null,
    preview_width: 320,
    preview_height: 240
  };

  window.NodeRenderers.pointer = function(node, body, el) {
    const pins = window.App.createPinsLayout(node, 
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
      window.App.saveCanvas();
      window.App.refreshNodeDOM(node);
    };

    const btnNeg = document.createElement('button');
    btnNeg.className = `pointer-btn ${node.properties.active_mode === 'negative' ? 'active-neg' : ''}`;
    btnNeg.innerHTML = '<span>➖</span> Neg';
    btnNeg.onclick = () => {
      node.properties.active_mode = 'negative';
      window.App.saveCanvas();
      window.App.refreshNodeDOM(node);
    };

    const btnReset = document.createElement('button');
    btnReset.className = 'pointer-btn btn-reset';
    btnReset.innerHTML = '<span>🔄</span> Reset';
    btnReset.onclick = () => {
      node.properties.points = [];
      window.App.saveCanvas();
      window.App.refreshNodeDOM(node);
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
      window.App.saveCanvas();
    };

    const isImageConnected = window.App.getConnections().some(c => c.toNodeId === node.id && c.toPinName === 'image');

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
        setTimeout(() => window.App.updatePointerNodeImage(node.id), 0);
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
          window.App.saveCanvas();
          window.App.renderPointsOverlay(node);
        };

        wrapper.appendChild(img);
        previewContainer.appendChild(wrapper);
        setTimeout(() => window.App.renderPointsOverlay(node), 0);
      }
    }

    body.appendChild(previewContainer);
  };
})();
