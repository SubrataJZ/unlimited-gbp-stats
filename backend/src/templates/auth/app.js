/* Auth pages client. One script, four modes (login | signup | forgot | reset),
   selected by <body data-mode>. Talks to ../api/auth/* so it works whether the
   pages are served at /auth/* or behind a /backend/auth/* proxy prefix. */
(function () {
  'use strict';

  var mode = document.body.getAttribute('data-mode') || 'login';
  var banner = document.getElementById('banner');
  var nav = document.getElementById('nav');
  var sub = document.getElementById('brandSub');

  // Reset token comes from the URL (?token=...), never from a form field.
  var params = new URLSearchParams(location.search);
  var resetToken = params.get('token') || '';

  var SUBTITLES = {
    login: 'Sign in to your account',
    signup: 'Create your account',
    forgot: 'Reset your password',
    reset: 'Set a new password',
  };
  if (sub && SUBTITLES[mode]) sub.textContent = SUBTITLES[mode];

  function show(name) {
    var el = document.querySelector('[data-form="' + name + '"]');
    if (el) el.hidden = false;
  }
  function hideAllForms() {
    document.querySelectorAll('[data-form]').forEach(function (el) { el.hidden = true; });
  }
  function setBanner(msg, kind) {
    banner.textContent = msg;
    banner.className = 'banner ' + (kind || 'error');
    banner.hidden = false;
  }
  function clearBanner() { banner.hidden = true; }

  function link(href, text) {
    var a = document.createElement('a');
    a.href = href;
    a.textContent = text;
    return a;
  }
  function setNav(items) {
    nav.innerHTML = '';
    items.forEach(function (pair) {
      var span = document.createElement('span');
      if (pair.pre) span.appendChild(document.createTextNode(pair.pre + ' '));
      span.appendChild(link(pair.href, pair.text));
      nav.appendChild(span);
    });
  }

  // Relative to the current page (…/auth/<mode>) → …/api/auth/<path>
  function api(path) { return '../api/auth/' + path; }

  async function post(path, body) {
    var res;
    try {
      res = await fetch(api(path), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(body),
      });
    } catch (e) {
      return { ok: false, status: 0, data: {} };
    }
    var data = {};
    try { data = await res.json(); } catch (e) { /* empty body */ }
    return { ok: res.ok, status: res.status, data: data };
  }

  function errText(r, fallback) {
    return (r.data && r.data.error && r.data.error.message)
      || (r.data && r.data.message)
      || fallback;
  }

  function succeed(title, bodyText, navItems) {
    hideAllForms();
    clearBanner();
    document.getElementById('doneTitle').textContent = title;
    document.getElementById('doneBody').textContent = bodyText;
    show('done');
    if (navItems) setNav(navItems);
  }

  function busy(form, on) {
    var btn = form.querySelector('button[type="submit"]');
    if (btn) btn.disabled = on;
  }

  // ── Wire the active form ────────────────────────────────────────────────────
  if (mode === 'login') {
    show('login');
    setNav([
      { pre: 'New here?', href: './signup', text: 'Create an account' },
      { href: './forgot-password', text: 'Forgot your password?' },
    ]);
    var lf = document.querySelector('[data-form="login"]');
    lf.addEventListener('submit', async function (e) {
      e.preventDefault();
      clearBanner(); busy(lf, true);
      var r = await post('login', {
        email: lf.email.value.trim(),
        password: lf.password.value,
      });
      busy(lf, false);
      if (r.ok) {
        succeed('Signed in', 'You can close this tab and open the extension.', [
          { href: './login', text: 'Back to sign in' },
        ]);
      } else if (r.status === 429) {
        setBanner(errText(r, 'Too many attempts. Try again in a few minutes.'));
      } else {
        setBanner(errText(r, 'Incorrect email or password.'));
      }
    });
  }

  else if (mode === 'signup') {
    show('signup');
    setNav([{ pre: 'Already have an account?', href: './login', text: 'Sign in' }]);
    var sf = document.querySelector('[data-form="signup"]');
    sf.addEventListener('submit', async function (e) {
      e.preventDefault();
      clearBanner();
      if (sf.password.value.length < 8) return setBanner('Password must be at least 8 characters.');
      if (sf.password.value !== sf.confirm.value) return setBanner('Passwords do not match.');
      busy(sf, true);
      var r = await post('register', {
        name: sf.name.value.trim(),
        email: sf.email.value.trim(),
        password: sf.password.value,
      });
      busy(sf, false);
      if (r.ok) {
        succeed('Account created', 'You can close this tab and open the extension.', [
          { href: './login', text: 'Go to sign in' },
        ]);
      } else if (r.status === 409) {
        setBanner('An account with this email already exists. Sign in instead.');
      } else if (r.status === 429) {
        setBanner(errText(r, 'Too many attempts. Try again in a few minutes.'));
      } else {
        setBanner(errText(r, 'Could not create the account.'));
      }
    });
  }

  else if (mode === 'forgot') {
    show('forgot');
    setNav([{ href: './login', text: 'Back to sign in' }]);
    var ff = document.querySelector('[data-form="forgot"]');
    ff.addEventListener('submit', async function (e) {
      e.preventDefault();
      clearBanner(); busy(ff, true);
      var r = await post('forgot-password', { email: ff.email.value.trim() });
      busy(ff, false);
      // Always the same outcome — never reveal whether the account exists.
      if (r.status === 429) {
        setBanner(errText(r, 'Too many attempts. Try again in a few minutes.'));
      } else {
        succeed('Check your email',
          'If an account exists for that address, a reset link is on its way. The link is valid for 30 minutes.',
          [{ href: './login', text: 'Back to sign in' }]);
      }
    });
  }

  else if (mode === 'reset') {
    setNav([{ href: './login', text: 'Back to sign in' }]);
    if (!resetToken) {
      setBanner('This reset link is missing its token. Request a new one from the "Forgot password" page.');
    } else {
      show('reset');
      var rf = document.querySelector('[data-form="reset"]');
      rf.addEventListener('submit', async function (e) {
        e.preventDefault();
        clearBanner();
        if (rf.password.value.length < 8) return setBanner('Password must be at least 8 characters.');
        if (rf.password.value !== rf.confirm.value) return setBanner('Passwords do not match.');
        busy(rf, true);
        var r = await post('reset-password', { token: resetToken, password: rf.password.value });
        busy(rf, false);
        if (r.ok) {
          succeed('Password updated', 'You can now sign in with your new password.', [
            { href: './login', text: 'Go to sign in' },
          ]);
        } else if (r.status === 401) {
          setBanner('This reset link is invalid or has expired. Request a new one.');
        } else if (r.status === 429) {
          setBanner(errText(r, 'Too many attempts. Try again in a few minutes.'));
        } else {
          setBanner(errText(r, 'Could not update the password.'));
        }
      });
    }
  }
})();
