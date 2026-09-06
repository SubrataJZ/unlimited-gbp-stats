/**
 * Auth page — handles sign in and sign up.
 * On success, stores token + user in chrome.storage then closes this tab.
 */

// ── Wire up all event listeners (replaces inline HTML handlers — MV3 CSP blocks those) ──
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('loginTab').addEventListener('click', () => switchTab('login'));
  document.getElementById('signupTab').addEventListener('click', () => switchTab('signup'));
  document.getElementById('loginForm').addEventListener('submit', handleLogin);
  document.getElementById('signupForm').addEventListener('submit', handleSignup);
  document.getElementById('toggleLoginPw').addEventListener('click', () => togglePw('loginPassword'));
  document.getElementById('toggleSignupPw').addEventListener('click', () => togglePw('signupPassword'));
  document.getElementById('googleLoginBtn').addEventListener('click', handleGoogleSignIn);
  document.getElementById('googleSignupBtn').addEventListener('click', handleGoogleSignIn);
  document.getElementById('forgotPwLink').addEventListener('click', () => {
    // Reset happens on the web (needs the emailed link), not in the extension.
    chrome.runtime.sendMessage({ action: 'openAuthPage', page: 'forgot-password' });
  });
});

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

// ── Handle Google sign-in (works for both sign-in and sign-up) ────────────────
async function handleGoogleSignIn() {
  const btns = [document.getElementById('googleLoginBtn'), document.getElementById('googleSignupBtn')];
  btns.forEach(b => { if (b) { b.disabled = true; b.textContent = 'Opening Google…'; } });
  hideBanner();

  try {
    const res = await chrome.runtime.sendMessage({ action: 'authGoogleLogin' });
    if (res?.success) {
      showBanner('✅ Signed in with Google! Closing…', 'success');
      setTimeout(() => window.close(), 800);
    } else {
      showBanner(res?.error || 'Google sign-in failed. Please try again.');
    }
  } catch (err) {
    showBanner('Could not connect. Check your internet connection.');
  } finally {
    btns.forEach(b => {
      if (b) {
        b.disabled = false;
        b.innerHTML = `<svg width="18" height="18" viewBox="0 0 48 48"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.08 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.18 1.48-4.97 2.36-8.16 2.36-6.26 0-11.57-3.59-13.46-8.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg> Continue with Google`;
      }
    });
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
