(function() {
  window.NodeDefaults.folder = {
    images_dir: '',
    labels_dir: '',
    classes: [
      { name: 'person', color: '#10b981' },
      { name: 'car', color: '#3b82f6' }
    ]
  };

  window.NodeRenderers.folder = function(node, body, el) {
    const pins = window.App.createPinsLayout(node, [], [
      { name: 'image', label: 'Image' },
      { name: 'annotation', label: 'Annotation' },
      { name: 'class', label: 'Class' }
    ]);
    body.append(
      pins,
      window.App.createInputField('Images Folder', 'text', node.properties.images_dir, (v) => {
        node.properties.images_dir = v;
        window.App.saveCanvas();
        window.App.refreshConnectedPointers(node.id);
      }),
      window.App.createInputField('Labels Folder', 'text', node.properties.labels_dir, (v) => {
        node.properties.labels_dir = v;
        window.App.saveCanvas();
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
      window.App.renderClassesList(node);
      window.App.saveCanvas();
      window.App.refreshAllYoloBindings();
    };
    classGroup.append(addBtn);
    body.append(classGroup);
    setTimeout(() => window.App.renderClassesList(node), 0);
  };
})();
