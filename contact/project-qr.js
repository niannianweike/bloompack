(() => {
  const imageUrl = new URL('./wechat-official-account.jpg', document.currentScript.src);
  const panel = document.createElement('div');
  panel.className = 'project-qr-panel';
  panel.id = 'project-qr-panel';
  panel.hidden = true;
  panel.setAttribute('role', 'region');
  panel.setAttribute('aria-label', '念念微课公众号二维码');
  panel.innerHTML = '<div class="project-qr-head"><strong>念念微课</strong><button class="project-qr-close" type="button">收起</button></div><img width="258" height="258" alt="念念微课公众号二维码"><p>微信扫一扫 · 长按识别</p>';
  const nativePopover = typeof panel.showPopover === 'function';
  if (nativePopover) panel.setAttribute('popover', 'manual');
  const qrImage = panel.querySelector('img');
  let trigger = null;

  function position() {
    if (!trigger) return;
    if (!trigger.getClientRects().length) { close(false); return; }
    const anchor = trigger.getBoundingClientRect();
    const gap = 7, margin = 10;
    const w = panel.offsetWidth, h = panel.offsetHeight;
    const preferredTop = anchor.bottom + gap + h <= innerHeight - margin
      ? anchor.bottom + gap : anchor.top - gap - h;
    const top = Math.min(Math.max(margin, preferredTop), innerHeight - h - margin);
    const left = Math.min(Math.max(margin, anchor.left + (anchor.width - w) / 2), innerWidth - w - margin);
    panel.style.top = Math.max(margin, top) + 'px';
    panel.style.left = Math.max(margin, left) + 'px';
  }

  function close(restoreFocus) {
    if (!trigger) return;
    const previous = trigger;
    trigger = null;
    previous.setAttribute('aria-expanded', 'false');
    if (nativePopover) panel.hidePopover();
    panel.hidden = true;
    if (restoreFocus) previous.focus({ preventScroll: true });
  }

  function open(button) {
    trigger = button;
    button.setAttribute('aria-expanded', 'true');
    (button.closest('dialog') || document.body).append(panel);
    if (!qrImage.hasAttribute('src')) qrImage.src = imageUrl.href;
    panel.hidden = false;
    if (nativePopover) panel.showPopover();
    position();
  }

  document.addEventListener('click', event => {
    const button = event.target.closest('button[data-project-qr]');
    if (button) {
      const alreadyOpen = trigger === button;
      close(false);
      if (!alreadyOpen) open(button);
    } else if (event.target.closest('.project-qr-close')) {
      close(true);
    } else if (trigger && !panel.contains(event.target)) {
      close(false);
    }
  });
  // Install before the word game's orientation notice handles keyboard events.
  window.addEventListener('keydown', event => {
    if (event.key === 'Escape' && trigger) {
      event.preventDefault();
      event.stopImmediatePropagation();
      close(true);
    } else if (event.target.closest?.('.rotate-phone') &&
               (event.key === 'Enter' || event.key === ' ') &&
               event.target.matches('button[data-project-qr], .project-qr-close')) {
      event.stopImmediatePropagation();
    }
  }, true);
  window.addEventListener('resize', position);
  window.addEventListener('scroll', position, true);
  matchMedia('(orientation: portrait)').addEventListener('change', () => close(false));
  window.addEventListener('pagehide', () => close(false));
  document.addEventListener('DOMContentLoaded', () => {
    const notice = document.querySelector('.rotate-phone');
    const button = document.querySelector('[data-project-qr-rotation]');
    if (notice && button) notice.append(button.cloneNode(true));
  }, { once: true });
})();
