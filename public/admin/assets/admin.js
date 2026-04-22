(async function() {
  var statusEl = document.getElementById('status');
  var outputEl = document.getElementById('config-output');
  try {
    var res = await fetch('/admin/config');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    var data = await res.json();
    statusEl.textContent = 'Connected (runtimeVersion: ' + data.runtimeVersion + ')';
    outputEl.textContent = JSON.stringify(data, null, 2);
  } catch (err) {
    statusEl.textContent = 'Error: ' + err.message;
  }
})();
