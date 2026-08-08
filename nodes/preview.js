(function() {
  window.NodeDefaults.preview = {
    last_preview: null,
    preview_width: 320,
    preview_height: 240
  };

  window.NodeRenderers.preview = function(node, body, el) {
    const pins = window.App.createPinsLayout(node, 
      [
        { name: 'image', label: 'Image' },
        { name: 'annotation', label: 'Annotation' },
        { name: 'class', label: 'Class', optional: true }
      ],
      []
    );
    body.appendChild(pins);

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
