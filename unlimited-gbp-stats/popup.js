/**
 * Popup Script — business switcher, stats overview, and auth state.
 */

document.addEventListener('DOMContentLoaded', async () => {
  await loadAuthState();
  await loadStats();
  await loadBusinesses();

  document.getElementById('openDashboard').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
    window.close();
  });

  document.getElementById('goToGBP').addEventListener('click', () => {
    chrome.tabs.create({ url: 'https://business.google.com/' });
    window.close();
  });

  document.getElementById('exportBtn').addEventListener('click', exportData);
  document.getElementById('importBtn').addEventListener('click', () => {
    document.getElementById('importFile').click();
  });
  document.getElementById('importFile').addEventListener('change', importData);

  document.getElementById('signInBtn').addEventListener('click', openAuthPage);
  document.getElementById('logoutBtn').addEventListener('click', handleLogout);
});

async function loadAuthState() {
  const { gbpUser } = await chrome.storage.local.get(['gbpUser']);
  const authBanner     = document.getElementById('authBanner');
  const accountSection = document.getElementById('accountSection');
  if (gbpUser?.email) {
    authBanner.style.display     = 'none';
    accountSection.style.display = '';
    document.getElementById('accountEmail').textContent  = gbpUser.email;
    document.getElementById('accountStatus').textContent = '☁ Synced to server ✓';
    const initial = gbpUser.name?.[0] || gbpUser.email[0];
    document.getElementById('accountAvatar').textContent = initial.toUpperCase();
  } else {
    authBanner.style.display     = '';
    accountSection.style.display = 'none';
  }
}

function openAuthPage() {
  chrome.tabs.create({ url: chrome.runtime.getURL('auth.html') });
  window.close();
}

async function handleLogout() {
  await chrome.storage.local.remove(['gbpAuthToken', 'gbpUser']);
  await loadAuthState();
  showStatus('Signed out successfully.', 'success');
}

async function loadStats() {
  try {
    const stats = await GBPStorage.getStats();
    document.getElementById('totalBiz').textContent     = stats.totalBusinesses;
    document.getElementById('totalRecords').textContent = stats.totalRecords;
  } catch (e) { console.error('Failed to load stats:', e); }
}

async function loadBusinesses() {
  try {
    const businesses = await GBPStorage.getAllBusinesses();
    const stats      = await GBPStorage.getStats();
    const listEl     = document.getElementById('bizList');
    const emptyEl    = document.getElementById('emptyState');
    if (!businesses.length) { emptyEl.style.display = ''; return; }
    emptyEl.style.display = 'none';
    listEl.innerHTML = '';
    for (const biz of businesses) {
      const records = stats.recordsByBusiness[biz.id] || 0;
      const item    = document.createElement('div');
      item.className = 'biz-item';
      item.innerHTML = `<div class="biz-dot"></div><div class="biz-name">${escapeHtml(biz.name || biz.id)}</div><div class="biz-records">${records} records</div>`;
      item.addEventListener('click', () => {
        chrome.tabs.create({ url: chrome.runtime.getURL(`dashboard.html?business=${biz.id}`) });
        window.close();
      });
      listEl.appendChild(item);
    }
  } catch (e) { console.error('Failed to load businesses:', e); }
}

async function exportData() {
  try {
    const data = await GBPStorage.exportAll();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = `gbp-stats-export-${new Date().toISOString().slice(0,10)}.json`;
    a.click(); URL.revokeObjectURL(url);
    showStatus('Data exported successfully!', 'success');
  } catch (e) { showStatus('Export failed: ' + e.message, 'error'); }
}

async function importData(e) {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    await GBPStorage.importAll(data);
    showStatus(`Imported ${data.businesses.length} businesses, ${data.metrics.length} records`, 'success');
    await loadStats(); await loadBusinesses();
  } catch (err) { showStatus('Import failed: ' + err.message, 'error'); }
  e.target.value = '';
}

function showStatus(msg, type) {
  const el = document.getElementById('statusMsg');
  el.textContent = msg; el.className = `status-msg show ${type}`;
  setTimeout(() => { el.className = 'status-msg'; }, 4000);
}

function escapeHtml(str) {
  const div = document.createElement('div'); div.textContent = str; return div.innerHTML;
}
