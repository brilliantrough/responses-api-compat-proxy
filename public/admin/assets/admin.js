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
    var envChanged = JSON.stringify(draftEnv.map(function(e) { return { key: e.key, value: e.value, secretAction: e.secretAction }; })) !==
      JSON.stringify(serverConfig.env.map(function(e) { return { key: e.key, value: e.value, secretAction: e.secret || isSecret(e.key) ? 'keep' : undefined }; }));
    var fbChanged = JSON.stringify(draftFallback) !== JSON.stringify(serverConfig.fallbackProviders);
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
        input.dataset.secret = '1';
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
      tdVal.appendChild(input);
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
    for (var i = 0; i < draftFallback.length; i++) {
      var p = draftFallback[i];
      var tr = document.createElement('tr');
      var tdName = document.createElement('td');
      var nameInput = document.createElement('input');
      nameInput.type = 'text';
      nameInput.value = p.name;
      nameInput.dataset.idx = i;
      nameInput.dataset.field = 'name';
      nameInput.addEventListener('input', function() {
        draftFallback[parseInt(this.dataset.idx)].name = this.value;
        checkDirty();
      });
      tdName.appendChild(nameInput);
      tr.appendChild(tdName);

      var tdUrl = document.createElement('td');
      var urlInput = document.createElement('input');
      urlInput.type = 'text';
      urlInput.value = p.baseUrl;
      urlInput.dataset.idx = i;
      urlInput.dataset.field = 'baseUrl';
      urlInput.addEventListener('input', function() {
        draftFallback[parseInt(this.dataset.idx)].baseUrl = this.value;
        checkDirty();
      });
      tdUrl.appendChild(urlInput);
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
      modeSelect.dataset.idx = i;
      modeSelect.addEventListener('change', function() {
        draftFallback[parseInt(this.dataset.idx)].apiKeyMode = this.value;
        renderFallbackProviders();
        checkDirty();
      });
      tdMode.appendChild(modeSelect);
      tr.appendChild(tdMode);

      var tdEnv = document.createElement('td');
      var envInput = document.createElement('input');
      envInput.type = 'text';
      envInput.value = p.apiKeyEnv || '';
      envInput.dataset.idx = i;
      envInput.addEventListener('input', function() {
        draftFallback[parseInt(this.dataset.idx)].apiKeyEnv = this.value;
        checkDirty();
      });
      if (p.apiKeyMode !== 'env') envInput.disabled = true;
      tdEnv.appendChild(envInput);
      tr.appendChild(tdEnv);

      var tdConf = document.createElement('td');
      tdConf.textContent = p.apiKeyConfigured ? 'Yes' : 'No';
      tr.appendChild(tdConf);

      tbody.appendChild(tr);
    }
  }

  function renderModelMappings() {
    var container = document.getElementById('model-mappings-list');
    container.innerHTML = '';
    var keys = Object.keys(draftModelMappings);
    for (var i = 0; i < keys.length; i++) {
      (function(alias) {
        var row = document.createElement('div');
        row.className = 'kv-row';
        var aliasInput = document.createElement('input');
        aliasInput.type = 'text';
        aliasInput.value = alias;
        aliasInput.placeholder = 'alias';
        aliasInput.readOnly = true;
        row.appendChild(aliasInput);

        var arrow = document.createElement('span');
        arrow.textContent = ' \u2192 ';
        row.appendChild(arrow);

        var targetInput = document.createElement('input');
        targetInput.type = 'text';
        targetInput.value = draftModelMappings[alias];
        targetInput.placeholder = 'target model';
        targetInput.dataset.alias = alias;
        targetInput.addEventListener('input', function() {
          draftModelMappings[this.dataset.alias] = this.value;
          checkDirty();
        });
        row.appendChild(targetInput);

        var delBtn = document.createElement('button');
        delBtn.textContent = 'x';
        delBtn.addEventListener('click', function() {
          delete draftModelMappings[alias];
          renderModelMappings();
          checkDirty();
        });
        row.appendChild(delBtn);
        container.appendChild(row);
      })(keys[i]);
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
      var d = { key: e.key, value: e.value };
      if (e.secret || isSecret(e.key)) {
        d.secretAction = 'keep';
      }
      return d;
    });
    draftFallback = JSON.parse(JSON.stringify(serverConfig.fallbackProviders || []));
    draftModelMappings = JSON.parse(JSON.stringify(serverConfig.modelMappings || {}));
  }

  function buildDraftPayload() {
    return {
      env: draftEnv,
      fallbackProviders: draftFallback.map(function(p) {
        var out = { name: p.name, baseUrl: p.baseUrl, apiKeyMode: p.apiKeyMode || 'none' };
        if (p.apiKeyEnv) out.apiKeyEnv = p.apiKeyEnv;
        if (p.secretAction) out.secretAction = p.secretAction;
        if (p.value) out.value = p.value;
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
