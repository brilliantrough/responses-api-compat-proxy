(function() {
  var statusEl = document.getElementById('status');
  var dirtyBadge = document.getElementById('dirty-badge');
  var restartNotice = document.getElementById('restart-notice');
  var validationResult = document.getElementById('validation-result');
  var actionResult = document.getElementById('action-result');

  var serverConfig = null;
  var serverMeta = null;
  var draftEnv = [];
  var draftFallback = [];
  var draftModelMappings = {};
  var dirty = false;
  var draggingFallbackIndex = -1;
  var armedFallbackDragIndex = -1;

  var RUNTIME_KEYS = [
    'PORT', 'HOST', 'INSTANCE_NAME', 'PROXY_STREAM_MODE',
    'PROXY_UPSTREAM_TIMEOUT_MS', 'PROXY_NON_STREAM_TIMEOUT_MS',
    'PROXY_TOTAL_REQUEST_TIMEOUT_MS', 'PROXY_MAX_CONCURRENT_REQUESTS',
    'PROXY_FORCE_STORE_FALSE', 'PROXY_CONVERT_SYSTEM_TO_DEVELOPER',
    'PROXY_PROMPT_CACHE_RETENTION', 'PROXY_PROMPT_CACHE_KEY'
  ];

  function isSecret(key) {
    var u = key.toUpperCase();
    return u.indexOf('KEY') >= 0 || u.indexOf('TOKEN') >= 0 || u.indexOf('SECRET') >= 0;
  }

  function esc(s) {
    var d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  function appendHelperText(container, text) {
    if (!text) return;
    var helperEl = document.createElement('div');
    helperEl.className = 'field-helper';
    helperEl.textContent = text;
    container.appendChild(helperEl);
  }

  function getEnvHelperText(key) {
    var helpers = {
      PRIMARY_PROVIDER_BASE_URL: 'Base URL that must expose /v1/responses and /v1/models.',
      PRIMARY_PROVIDER_API_KEY: 'Stored in .env and masked in this UI.',
      PRIMARY_PROVIDER_DEFAULT_MODEL: 'Used as the default upstream model for quick testing.',
      PROXY_ENV_PATH: 'Admin reads and writes this .env file path.',
      FALLBACK_CONFIG_PATH: 'JSON file saved when fallback providers are updated.',
      MODEL_MAP_PATH: 'JSON file saved when model mappings are updated.'
    };
    return helpers[key] || '';
  }

  function getFallbackHelperText(field) {
    var helpers = {
      name: 'Shown in stats and cooldown state.',
      baseUrl: 'Base URL used for /v1/responses and /v1/models.',
      apiKeyMode: 'env reads a variable name; inline stores a masked secret in config.',
      apiKeyEnv: 'Variable name read from .env at runtime.'
    };
    return helpers[field] || '';
  }

  function getModelMappingHelperText(kind) {
    if (kind === 'alias') return 'Client-facing model name accepted by the proxy.';
    if (kind === 'target') return 'Actual upstream model sent after mapping.';
    return '';
  }

  function createFieldStack(control, helperText) {
    var stack = document.createElement('div');
    stack.className = 'field-stack';
    stack.appendChild(control);
    appendHelperText(stack, helperText);
    return stack;
  }

  function removeFallbackProvider(index) {
    draftFallback.splice(index, 1);
    renderFallbackProviders();
    checkDirty();
  }

  function moveFallbackProvider(fromIndex, toIndex) {
    if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0) return;
    var moved = draftFallback.splice(fromIndex, 1)[0];
    draftFallback.splice(toIndex, 0, moved);
    renderFallbackProviders();
    checkDirty();
  }

  function setStatus(text, isError) {
    statusEl.textContent = text;
    statusEl.className = isError ? 'error' : '';
  }

  function setDirty(v) {
    dirty = v;
    dirtyBadge.style.display = v ? 'inline-block' : 'none';
    dirtyBadge.className = v ? 'badge badge-dirty' : 'badge badge-ok';
  }

  function checkDirty() {
    if (!serverConfig) return;
    var origEnv = serverConfig.env.map(function(e) {
      return { key: e.key, secretAction: (e.secret || isSecret(e.key)) ? 'keep' : undefined };
    });
    var curEnv = draftEnv.map(function(e) {
      return { key: e.key, secretAction: e.secretAction || undefined };
    });
    var envChanged = JSON.stringify(curEnv) !== JSON.stringify(origEnv);
    var fbChanged = JSON.stringify(draftFallback.map(function(p) {
      return { name: p.name, baseUrl: p.baseUrl, apiKeyMode: p.apiKeyMode, apiKeyEnv: p.apiKeyEnv, secretAction: p.secretAction };
    })) !== JSON.stringify(serverConfig.fallbackProviders.map(function(p) {
      return { name: p.name, baseUrl: p.baseUrl, apiKeyMode: p.apiKeyMode, apiKeyEnv: p.apiKeyEnv, secretAction: 'keep' };
    }));
    var mmChanged = JSON.stringify(draftModelMappings) !== JSON.stringify(serverConfig.modelMappings);
    setDirty(envChanged || fbChanged || mmChanged);
  }

  function showRestartNotice(fields) {
    if (fields && fields.length > 0) {
      var hasPortHost = fields.some(function(f) { return f === 'PORT' || f === 'HOST'; });
      restartNotice.style.display = 'block';
      restartNotice.className = hasPortHost ? 'notice-restart' : 'notice-error';
      restartNotice.textContent = hasPortHost
        ? 'Restart required: ' + fields.join(', ') + ' changed. Restart the proxy process for these to take effect.'
        : 'Fields changed: ' + fields.join(', ');
    } else {
      restartNotice.style.display = 'none';
    }
  }

  function renderOverview() {
    document.getElementById('ov-version').value = serverMeta.runtimeVersion || '-';
    document.getElementById('ov-restart').value = (serverMeta.restartRequiredFields || []).join(', ') || '(none)';
    var info = document.getElementById('ov-instance-info');
    var envArr = serverConfig.env || [];
    var inst = envArr.filter(function(e) { return e.key === 'INSTANCE_NAME'; })[0];
    var port = envArr.filter(function(e) { return e.key === 'PORT'; })[0];
    if (inst) {
      info.innerHTML = '<div class="field-group"><label>Instance</label><input readonly value="' + esc(inst.value) + '"></div>';
    }
    if (port) {
      info.innerHTML += '<div class="field-group"><label>Port</label><input readonly value="' + esc(port.value) + '"></div>';
    }
  }

  function renderPrimaryProvider() {
    var tbody = document.querySelector('#primary-table tbody');
    tbody.innerHTML = '';
    var envArr = serverConfig.env || [];
    for (var i = 0; i < envArr.length; i++) {
      var e = envArr[i];
      var draftEntry = draftEnv.filter(function(d) { return d.key === e.key; })[0];
      if (!draftEntry) continue;
      var tr = document.createElement('tr');
      var tdKey = document.createElement('td');
      tdKey.textContent = e.key;
      tr.appendChild(tdKey);
      var tdVal = document.createElement('td');
      var input = document.createElement('input');
      if (e.secret) {
        input.type = 'password';
        input.placeholder = '*** (masked)';
        input.value = '';
        input.dataset.key = e.key;
        input.addEventListener('input', function() {
          var k = this.dataset.key;
          for (var j = 0; j < draftEnv.length; j++) {
            if (draftEnv[j].key === k) {
              if (this.value) {
                draftEnv[j].secretAction = 'replace';
                draftEnv[j].value = this.value;
              } else {
                draftEnv[j].secretAction = 'keep';
                delete draftEnv[j].value;
              }
              break;
            }
          }
          checkDirty();
        });
      } else {
        input.type = 'text';
        input.value = draftEntry.value || '';
        input.dataset.key = e.key;
        input.addEventListener('input', function() {
          var k = this.dataset.key;
          for (var j = 0; j < draftEnv.length; j++) {
            if (draftEnv[j].key === k) {
              draftEnv[j].value = this.value;
              break;
            }
          }
          checkDirty();
        });
      }
      tdVal.appendChild(createFieldStack(input, getEnvHelperText(e.key)));
      tr.appendChild(tdVal);
      var tdSecret = document.createElement('td');
      tdSecret.textContent = e.secret ? 'Yes' : 'No';
      tr.appendChild(tdSecret);
      tbody.appendChild(tr);
    }
  }

  function renderFallbackProviders() {
    var tbody = document.querySelector('#fallback-table tbody');
    tbody.innerHTML = '';
    if (draftFallback.length === 0) {
      var emptyTr = document.createElement('tr');
      var emptyTd = document.createElement('td');
      emptyTd.colSpan = 7;
      emptyTd.className = 'loading';
      emptyTd.textContent = 'No fallback providers in the current draft.';
      emptyTr.appendChild(emptyTd);
      tbody.appendChild(emptyTr);
      return;
    }
    for (var i = 0; i < draftFallback.length; i++) {
      (function(index) {
      var p = draftFallback[index];
      var tr = document.createElement('tr');
      tr.setAttribute('draggable', 'true');
      tr.addEventListener('dragstart', function(event) {
        if (armedFallbackDragIndex !== index) {
          event.preventDefault();
          return;
        }
        draggingFallbackIndex = index;
        tr.classList.add('is-dragging');
        if (event.dataTransfer) {
          event.dataTransfer.effectAllowed = 'move';
          event.dataTransfer.setData('text/plain', String(index));
        }
      });
      tr.addEventListener('dragover', function(event) {
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
      });
      tr.addEventListener('drop', function(event) {
        event.preventDefault();
        moveFallbackProvider(draggingFallbackIndex, index);
      });
      tr.addEventListener('dragend', function() {
        draggingFallbackIndex = -1;
        armedFallbackDragIndex = -1;
        tr.classList.remove('is-dragging');
      });

      var tdMove = document.createElement('td');
      tdMove.className = 'drag-cell';
      var handle = document.createElement('button');
      handle.type = 'button';
      handle.className = 'drag-handle';
      handle.textContent = '::';
      handle.title = 'Drag to reorder';
      handle.addEventListener('mousedown', function() {
        armedFallbackDragIndex = index;
      });
      handle.addEventListener('mouseup', function() {
        armedFallbackDragIndex = -1;
      });
      tdMove.appendChild(handle);
      tr.appendChild(tdMove);

      var tdName = document.createElement('td');
      var nameInput = document.createElement('input');
      nameInput.type = 'text';
      nameInput.value = p.name;
      nameInput.dataset.idx = index;
      nameInput.addEventListener('input', function() {
        draftFallback[parseInt(this.dataset.idx)].name = this.value;
        checkDirty();
      });
      tdName.appendChild(createFieldStack(nameInput, getFallbackHelperText('name')));
      tr.appendChild(tdName);

      var tdUrl = document.createElement('td');
      var urlInput = document.createElement('input');
      urlInput.type = 'text';
      urlInput.value = p.baseUrl;
      urlInput.dataset.idx = index;
      urlInput.addEventListener('input', function() {
        draftFallback[parseInt(this.dataset.idx)].baseUrl = this.value;
        checkDirty();
      });
      tdUrl.appendChild(createFieldStack(urlInput, getFallbackHelperText('baseUrl')));
      tr.appendChild(tdUrl);

      var tdMode = document.createElement('td');
      var modeSelect = document.createElement('select');
      ['env', 'inline', 'none'].forEach(function(m) {
        var opt = document.createElement('option');
        opt.value = m;
        opt.textContent = m;
        if (p.apiKeyMode === m) opt.selected = true;
        modeSelect.appendChild(opt);
      });
      modeSelect.dataset.idx = index;
      modeSelect.addEventListener('change', function() {
        var idx = parseInt(this.dataset.idx);
        draftFallback[idx].apiKeyMode = this.value;
        if (this.value !== 'inline') {
          draftFallback[idx].secretAction = undefined;
          draftFallback[idx].value = undefined;
        } else {
          draftFallback[idx].secretAction = 'keep';
        }
        renderFallbackProviders();
        checkDirty();
      });
      tdMode.appendChild(createFieldStack(modeSelect, getFallbackHelperText('apiKeyMode')));
      tr.appendChild(tdMode);

      var tdEnv = document.createElement('td');
      if (p.apiKeyMode === 'env') {
        var envInput = document.createElement('input');
        envInput.type = 'text';
        envInput.value = p.apiKeyEnv || '';
        envInput.dataset.idx = index;
        envInput.addEventListener('input', function() {
          draftFallback[parseInt(this.dataset.idx)].apiKeyEnv = this.value;
          checkDirty();
        });
        tdEnv.appendChild(createFieldStack(envInput, getFallbackHelperText('apiKeyEnv')));
      } else if (p.apiKeyMode === 'inline') {
        var inlineStack = document.createElement('div');
        inlineStack.className = 'field-stack';
        var inlinePwd = document.createElement('input');
        inlinePwd.type = 'password';
        inlinePwd.placeholder = '*** (masked)';
        inlinePwd.value = '';
        inlinePwd.dataset.idx = index;
        inlinePwd.addEventListener('input', function() {
          var idx = parseInt(this.dataset.idx);
          if (this.value) {
            draftFallback[idx].secretAction = 'replace';
            draftFallback[idx].value = this.value;
          } else {
            draftFallback[idx].secretAction = 'keep';
            draftFallback[idx].value = undefined;
          }
          checkDirty();
        });
        inlineStack.appendChild(inlinePwd);

        var actionSel = document.createElement('select');
        actionSel.style.marginTop = '0.3rem';
        ['keep', 'replace', 'clear'].forEach(function(a) {
          var opt = document.createElement('option');
          opt.value = a;
          opt.textContent = a;
          if ((p.secretAction || 'keep') === a) opt.selected = true;
          actionSel.appendChild(opt);
        });
        actionSel.dataset.idx = index;
        actionSel.addEventListener('change', function() {
          var idx = parseInt(this.dataset.idx);
          var action = this.value;
          draftFallback[idx].secretAction = action;
          if (action === 'keep') {
            draftFallback[idx].value = undefined;
          } else if (action === 'clear') {
            draftFallback[idx].value = undefined;
          }
          renderFallbackProviders();
          checkDirty();
        });
        var actionLabel = document.createElement('div');
        actionLabel.style.fontSize = '0.75rem';
        actionLabel.style.color = '#888';
        actionLabel.style.marginTop = '0.2rem';
        actionLabel.textContent = 'Action:';
        actionLabel.appendChild(actionSel);
        inlineStack.appendChild(actionLabel);
        appendHelperText(inlineStack, 'Inline mode keeps a masked secret in config until you save.');
        tdEnv.appendChild(inlineStack);
      } else {
        appendHelperText(tdEnv, 'No secret configured for this fallback row.');
      }
      tr.appendChild(tdEnv);

      var tdConf = document.createElement('td');
      tdConf.textContent = p.apiKeyConfigured ? 'Yes' : 'No';
      tr.appendChild(tdConf);

      var tdActions = document.createElement('td');
      var actions = document.createElement('div');
      actions.className = 'row-actions';
      var deleteBtn = document.createElement('button');
      deleteBtn.type = 'button';
      deleteBtn.className = 'danger icon-button';
      deleteBtn.textContent = 'Delete';
      deleteBtn.dataset.idx = index;
      deleteBtn.addEventListener('click', function() {
        removeFallbackProvider(parseInt(this.dataset.idx, 10));
      });
      actions.appendChild(deleteBtn);
      tdActions.appendChild(actions);
      tr.appendChild(tdActions);

      tbody.appendChild(tr);
      })(i);
    }
  }

  function renderModelMappings() {
    var container = document.getElementById('model-mappings-list');
    container.innerHTML = '';
    var keys = Object.keys(draftModelMappings);
    for (var i = 0; i < keys.length; i++) {
      (function(alias, idx) {
        var row = document.createElement('div');
        row.className = 'kv-row';
        var aliasCol = document.createElement('div');
        aliasCol.className = 'kv-col';
        var aliasInput = document.createElement('input');
        aliasInput.type = 'text';
        aliasInput.value = alias;
        aliasInput.placeholder = 'alias';
        aliasInput.dataset.origAlias = alias;
        aliasInput.addEventListener('input', function() {
          var orig = this.dataset.origAlias;
          var newAlias = this.value;
          var target = draftModelMappings[orig];
          delete draftModelMappings[orig];
          draftModelMappings[newAlias] = target;
          this.dataset.origAlias = newAlias;
          checkDirty();
        });
        aliasCol.appendChild(aliasInput);
        appendHelperText(aliasCol, getModelMappingHelperText('alias'));
        row.appendChild(aliasCol);

        var arrow = document.createElement('span');
        arrow.className = 'kv-arrow';
        arrow.textContent = ' \u2192 ';
        row.appendChild(arrow);

        var targetCol = document.createElement('div');
        targetCol.className = 'kv-col';
        var targetInput = document.createElement('input');
        targetInput.type = 'text';
        targetInput.value = draftModelMappings[alias];
        targetInput.placeholder = 'target model';
        targetInput.dataset.origAlias = alias;
        targetInput.addEventListener('input', function() {
          draftModelMappings[this.dataset.origAlias] = this.value;
          checkDirty();
        });
        targetCol.appendChild(targetInput);
        appendHelperText(targetCol, getModelMappingHelperText('target'));
        row.appendChild(targetCol);

        var delBtn = document.createElement('button');
        delBtn.textContent = 'x';
        delBtn.addEventListener('click', function() {
          delete draftModelMappings[alias];
          renderModelMappings();
          checkDirty();
        });
        row.appendChild(delBtn);
        container.appendChild(row);
      })(keys[i], i);
    }
  }

  function renderRuntime() {
    var tbody = document.querySelector('#runtime-table tbody');
    tbody.innerHTML = '';
    var envArr = serverConfig.env || [];
    for (var i = 0; i < envArr.length; i++) {
      var e = envArr[i];
      if (RUNTIME_KEYS.indexOf(e.key) < 0) continue;
      var tr = document.createElement('tr');
      var tdKey = document.createElement('td');
      tdKey.textContent = e.key;
      tr.appendChild(tdKey);
      var tdVal = document.createElement('td');
      tdVal.textContent = e.secret ? '***' : e.value;
      tr.appendChild(tdVal);
      tbody.appendChild(tr);
    }
  }

  function render() {
    renderOverview();
    renderPrimaryProvider();
    renderFallbackProviders();
    renderModelMappings();
    renderRuntime();
    showRestartNotice(serverMeta.restartRequiredFields);
    setDirty(false);
  }

  function initDraft() {
    draftEnv = (serverConfig.env || []).map(function(e) {
      var d = { key: e.key };
      if (e.secret || isSecret(e.key)) {
        d.secretAction = 'keep';
      } else {
        d.value = e.value;
      }
      return d;
    });
    draftFallback = (serverConfig.fallbackProviders || []).map(function(p) {
      var d = JSON.parse(JSON.stringify(p));
      if (d.apiKeyMode === 'inline') {
        d.secretAction = 'keep';
      }
      return d;
    });
    draftModelMappings = JSON.parse(JSON.stringify(serverConfig.modelMappings || {}));
  }

  function buildDraftPayload() {
    return {
      env: draftEnv.map(function(e) {
        var d = { key: e.key };
        if (e.secretAction) {
          d.secretAction = e.secretAction;
          if (e.secretAction === 'replace' && e.value !== undefined) {
            d.value = e.value;
          }
        } else {
          d.value = e.value;
        }
        return d;
      }),
      fallbackProviders: draftFallback.map(function(p) {
        var out = { name: p.name, baseUrl: p.baseUrl, apiKeyMode: p.apiKeyMode || 'none' };
        if (p.apiKeyMode === 'env' && p.apiKeyEnv) out.apiKeyEnv = p.apiKeyEnv;
        if (p.apiKeyMode === 'inline') {
          out.secretAction = p.secretAction || 'keep';
          if (p.secretAction === 'replace' && p.value) {
            out.value = p.value;
          }
        }
        return out;
      }),
      modelMappings: JSON.parse(JSON.stringify(draftModelMappings))
    };
  }

  function showActionResult(text, isError) {
    actionResult.innerHTML = '';
    actionResult.className = isError ? 'notice-error' : 'notice-success';
    actionResult.textContent = text;
  }

  function showValidationResult(body) {
    validationResult.innerHTML = '';
    if (body.valid) {
      var div = document.createElement('div');
      div.className = 'validation-result validation-valid';
      div.textContent = 'Draft is valid.';
      if (body.warnings && body.warnings.length > 0) {
        div.textContent += ' Warnings: ' + body.warnings.join('; ');
      }
      validationResult.appendChild(div);
    } else {
      var div = document.createElement('div');
      div.className = 'validation-result validation-invalid';
      div.textContent = 'Validation errors:';
      var ul = document.createElement('ul');
      ul.className = 'validation-errors';
      (body.errors || []).forEach(function(e) {
        var li = document.createElement('li');
        li.textContent = e;
        ul.appendChild(li);
      });
      div.appendChild(ul);
      validationResult.appendChild(div);
    }
  }

  async function loadConfig() {
    setStatus('Loading...');
    try {
      var res = await fetch('/admin/config');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      var data = await res.json();
      if (!data.ok) throw new Error(data.error?.message || 'Unknown error');
      serverConfig = data.config;
      serverMeta = { runtimeVersion: data.runtimeVersion, restartRequiredFields: data.restartRequiredFields || [] };
      initDraft();
      render();
      setStatus('Connected (runtimeVersion: ' + data.runtimeVersion + ')');
    } catch (err) {
      setStatus('Error: ' + err.message, true);
    }
  }

  document.getElementById('btn-add-mapping').addEventListener('click', function() {
    var alias = 'new-alias-' + Date.now();
    draftModelMappings[alias] = '';
    renderModelMappings();
    setDirty(true);
  });

  document.getElementById('btn-validate').addEventListener('click', async function() {
    validationResult.innerHTML = '<div class="loading">Validating...</div>';
    try {
      var res = await fetch('/admin/config/validate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(buildDraftPayload())
      });
      var data = await res.json();
      showValidationResult(data);
    } catch (err) {
      validationResult.innerHTML = '<div class="validation-result validation-invalid">' + esc(err.message) + '</div>';
    }
  });

  document.getElementById('btn-save').addEventListener('click', async function() {
    actionResult.innerHTML = '';
    try {
      var res = await fetch('/admin/config', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(buildDraftPayload())
      });
      var data = await res.json();
      if (data.ok) {
        showActionResult('Saved and reloaded (v' + data.runtimeVersion + ')', false);
        await loadConfig();
      } else {
        showActionResult('Save failed: ' + (data.error?.message || 'Unknown error'), true);
      }
    } catch (err) {
      showActionResult('Save error: ' + err.message, true);
    }
  });

  document.getElementById('btn-reload').addEventListener('click', async function() {
    actionResult.innerHTML = '';
    try {
      var res = await fetch('/admin/config/reload', { method: 'POST' });
      var data = await res.json();
      if (data.ok) {
        showActionResult('Reloaded (v' + data.runtimeVersion + ')', false);
        await loadConfig();
      } else {
        showActionResult('Reload failed: ' + (data.error?.message || 'Unknown error'), true);
      }
    } catch (err) {
      showActionResult('Reload error: ' + err.message, true);
    }
  });

  document.getElementById('btn-rollback').addEventListener('click', async function() {
    actionResult.innerHTML = '';
    try {
      var res = await fetch('/admin/config/rollback', { method: 'POST' });
      var data = await res.json();
      if (data.ok) {
        showActionResult('Rolled back. Restored: ' + (data.restored || []).join(', '), false);
        await loadConfig();
      } else {
        showActionResult('Rollback failed: ' + (data.error?.message || 'Unknown error'), true);
      }
    } catch (err) {
      showActionResult('Rollback error: ' + err.message, true);
    }
  });

  loadConfig();
})();
