/**
 * ClassQU — shared site chrome (loaded by every page with `defer`).
 *
 * Contains ONLY presentation behaviour that is identical on every page, so the
 * markup/JS is never duplicated:
 *   1. mobile hamburger / slide-out drawer (same markup contract as before:
 *      #navToggle, #drawer, #drawerOverlay)
 *   2. active nav highlighting (including the drawer copy of the links)
 *   3. footer copyright year ([data-year])
 *   4. signed-in swap on public pages ([data-auth-swap] -> /api/me)
 *
 * No user data is stored or cached here, nothing is written to the console,
 * and no credential/secret is ever read. Each page keeps its own API logic.
 */
(function () {
  'use strict';

  var drawer = null;
  var overlay = null;
  var toggle = null;

  function setDrawer(open) {
    if (!drawer || !overlay || !toggle) return;
    drawer.classList.toggle('open', open);
    overlay.classList.toggle('open', open);
    toggle.setAttribute('aria-expanded', String(open));
    toggle.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
    toggle.textContent = open ? '✕' : '☰';
    drawer.setAttribute('aria-hidden', String(!open));
    document.body.classList.toggle('drawer-open', open);
  }

  function initDrawer() {
    drawer = document.getElementById('drawer');
    overlay = document.getElementById('drawerOverlay');
    toggle = document.getElementById('navToggle');
    if (!drawer || !overlay || !toggle) return;

    var head = drawer.querySelector('.drawer-head');
    var closeBtn = drawer.querySelector('.drawer-close');
    if (!closeBtn && head) {
      closeBtn = document.createElement('button');
      closeBtn.type = 'button';
      closeBtn.className = 'drawer-close';
      closeBtn.setAttribute('aria-label', 'Close menu');
      closeBtn.textContent = '✕';
      head.appendChild(closeBtn);
    }
    if (closeBtn) {
      closeBtn.addEventListener('click', function () {
        setDrawer(false);
      });
    }

    toggle.addEventListener('click', function () {
      setDrawer(!drawer.classList.contains('open'));
    });
    overlay.addEventListener('click', function () {
      setDrawer(false);
    });
    Array.prototype.forEach.call(drawer.querySelectorAll('a, .drawer-close'), function (el) {
      el.addEventListener('click', function () {
        setDrawer(false);
      });
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') setDrawer(false);
    });
  }

  /** Highlight the current page in the top nav AND the mobile drawer. */
  function markActiveNav() {
    var here = location.pathname.replace(/\/+$/, '') || '/';
    var links = document.querySelectorAll('.nav-links a[href], .drawer-nav a[href]');
    Array.prototype.forEach.call(links, function (a) {
      var target = a.getAttribute('href') || '';
      if (target.charAt(0) !== '/') return;
      if (target.replace(/\/+$/, '') === here) a.classList.add('active');
    });
  }

  function initYear() {
    var year = String(new Date().getFullYear());
    Array.prototype.forEach.call(document.querySelectorAll('[data-year]'), function (el) {
      el.textContent = year;
    });
  }

  /**
   * Public pages show Login/Register. If a session already exists, swap every
   * auth action cluster for Dashboard + Logout (existing /api/me endpoint).
   */
  function initAuthSwap() {
    var zones = document.querySelectorAll('[data-auth-swap]');
    if (!zones.length) return;
    fetch('/api/me', { credentials: 'same-origin' })
      .then(function (res) {
        return res.ok ? res.json() : null;
      })
      .then(function (me) {
        if (!me) return;
        Array.prototype.forEach.call(document.querySelectorAll('[data-auth-guest]'), function (el) {
          el.hidden = true;
        });
        Array.prototype.forEach.call(zones, function (zone) {
          zone.textContent = '';
          zone.hidden = false;
          var dashboard = document.createElement('a');
          dashboard.className = 'btn';
          dashboard.href = '/dashboard';
          dashboard.textContent = 'Dashboard';
          zone.appendChild(dashboard);
          var logout = document.createElement('a');
          logout.className = 'btn btn-outline';
          logout.href = '/logout';
          logout.textContent = 'Logout';
          zone.appendChild(logout);
        });
      })
      .catch(function () {
        /* offline / API down — keep the Login + Register buttons as-is */
      });
  }

  function init() {
    initDrawer();
    markActiveNav();
    initYear();
    initAuthSwap();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
