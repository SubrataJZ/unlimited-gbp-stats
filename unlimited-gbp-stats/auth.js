/**
 * Auth page — handles sign in and sign up.
 * On success, stores token + user in chrome.storage then closes this tab.
 */

// ── Switch between Login / Signup tabs ────────────────────────────────────────
function switchTab(tab) {
  const isLogin = tab === 'login';
  document.getElementById('loginForm').classList.toggle('hidden', !isLogin);
  document.getElementById('signupForm').classList.toggle('hidden', isLogin);
  document.getElementById('loginTab').classList.toggle('active', isLogin);
  document.getElementById('signupTab').classList.toggle('active', !isLogin);
  hideBanner();
}

// ── Show/hide password toggle ──────────────────────────────────────────────────
function togglePw(id) {
  const input = document.getElementById(id);
  input.type = input.type === 'password' ? 'text' : 'password';
}

// ── Banner helpers ─────────────────────────────────────────────────────────────
function showBanner(msg, type = 'error') {
  const el = document.getElementById('authBanner');
  el.textContent = msg;
  el.className = `auth-banner ${type}`;
}
function hideBanner() {
  document.getElementById('authBanner').className = 'auth-banner hidden';
}

// ── Set button loading state ───────────────────────────────────────────────────
function setLoading(btnId, loading) {
  const btn = document.getElementById(btnId);
  btn.disabled = loading;
  btn.querySelector('.btn-text').textContent = loading
    ? (btnId === 'loginBtn' ? 'Signing in…' : 'Creating account…')
    : (btnId === 'loginBtn' ? 'Sign In' : 'Create Account');
  btn.querySelector('.btn-loader').classList.toggle('hidden', !loading);
}

// ── Handle login ───────────────────────────────────────────────────────────────
async function handleLogin(e) {
  e.preventDefault();
  hideBanner();
  setLoading('loginBtn', true);

  const email    = document.getElementById('loginEmail').value.trim();
  const password = document.getElementById('loginPassword').value;

  try {
    const res  = await chrome.runtime.sendMessage({ action: 'authLogin', email, password });
    if (res?.success) {
      showBanner('✅ Signed in! Closing…', 'success');
      setTimeout(() => window.close(), 800);
    } else {
      showBanner(res?.error || 'Login failed. Please try again.');
    }
  } catch (err) {
    showBanner('Could not connect. Check your internet connection.');
  } finally {
    setLoading('loginBtn', false);
  }
}

// ── Handle signup ──────────────────────────────────────────────────────────────
async function handleSignup(e) {
  e.preventDefault();
  hideBanner();

  const name     = document.getElementById('signupName').value.trim();
  const email    = document.getElementById('signupEmail').value.trim();
  const password = document.getElementById('signupPassword').value;
  const confirm  = document.getElementById('signupConfirm').value;

  if (password !== confirm) {
    showBanner('Passwords do not match.');
    return;
  }
  if (password.length < 6) {
    showBanner('Password must be at least 6 characters.');
    return;
  }

  setLoading('signupBtn', true);

  try {
    const res = await chrome.runtime.sendMessage({ action: 'authRegister', email, password, name });
    if (res?.success) {
      showBanner('✅ Account created! Closing…', 'success');
      setTimeout(() => window.close(), 800);
    } else {
      showBanner(res?.error || 'Registration failed. Please try again.');
    }
  } catch (err) {
    showBanner('Could not connect. Check your internet connection.');
  } finally {
    setLoading('signupBtn', false);
  }
}
