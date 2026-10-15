// Light / dark toggle. A saved choice wins; otherwise dark on desktop and the
// system setting on mobile (the initial pick is made by the inline script in index.html).
export function initTheme() {
  const btn = document.getElementById('theme-toggle');
  if (!btn) return;
  const apply = (dark) => {
    if (dark) document.documentElement.dataset.theme = 'dark';
    else delete document.documentElement.dataset.theme;
    btn.setAttribute('aria-pressed', String(dark));
  };
  apply(document.documentElement.dataset.theme === 'dark');
  btn.addEventListener('click', () => {
    const dark = document.documentElement.dataset.theme !== 'dark';
    apply(dark);
    try { localStorage.setItem('theme', dark ? 'dark' : 'light'); } catch { /* storage unavailable */ }
  });

  // On mobile with no saved choice, keep following the system setting live.
  const mobile = matchMedia('(max-width: 768px)').matches || matchMedia('(pointer: coarse)').matches;
  let saved = null;
  try { saved = localStorage.getItem('theme'); } catch { /* storage unavailable */ }
  if (mobile && !saved) {
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
      let chosen = null;
      try { chosen = localStorage.getItem('theme'); } catch { /* ignore */ }
      if (!chosen) apply(e.matches);
    });
  }
}
