(function() {
  window.NodeDefaults.single_image = {
    image_path: 'test.jpg',
    annotation_path: '',
    classes: [
      { name: 'person', color: '#10b981' },
      { name: 'car', color: '#3b82f6' }
    ]
  };

  window.NodeRenderers.single_image = function(node, body, el) {
    const pins = window.App.createPinsLayout(node, [], [
      { name: 'image', label: 'Image' },
      { name: 'annotation', label: 'Annotation' },
      { name: 'class', label: 'Class' }
    ]);
    
    body.append(
      pins,
      window.App.createInputField('Image Path', 'text', node.properties.image_path, (v) => {
        node.properties.image_path = v;
        window.App.saveCanvas();
        window.App.refreshConnectedPointers(node.id);
      }),
      window.App.createInputField('Annotation Path (.txt)', 'text', node.properties.annotation_path, (v) => {
        node.properties.annotation_path = v;
        window.App.saveCanvas();
      })
    );

    // Drag and Drop support
    body.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.stopPropagation();
      el.classList.add('drag-over');
    });
    body.addEventListener('dragleave', (e) => {
      e.preventDefault();
      e.stopPropagation();
      el.classList.remove('drag-over');
    });
    body.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      el.classList.remove('drag-over');
      if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        window.App.uploadFileAndUpdateNode(e.dataTransfer.files[0], node.id);
      }
    });

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
      window.App.renderClassesList(node);
      window.App.saveCanvas();
      window.App.refreshAllYoloBindings();
    };
    classGroup.append(addBtn);
    body.append(classGroup);
    setTimeout(() => window.App.renderClassesList(node), 0);
  };
})();
