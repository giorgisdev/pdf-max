// Start-page splash: run each demo animation only while it's on screen.
export function initSplash() {
  document.getElementById('hero-open')?.addEventListener('click', () => document.getElementById('start-open')?.click());

  const dz = document.getElementById('dropzone');
  const open = () => document.getElementById('start-open')?.click();
  dz?.addEventListener('click', open);
  dz?.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });

  const demos = document.querySelectorAll('.demo');
  if (!('IntersectionObserver' in window)) { demos.forEach((d) => d.classList.add('playing')); return; }
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) e.target.classList.toggle('playing', e.isIntersecting);
  }, { threshold: 0.35 });
  demos.forEach((d) => io.observe(d));
}
