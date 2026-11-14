// 点击式说明提示：只显示帮助文字，不改变表单值或执行任何操作。
let activeHelpButton = null;

function makeHelpTip(title, text) {
  const button = document.createElement('button'); button.type = 'button'; button.className = 'help-tip';
  button.dataset.helpTitle = title; button.dataset.helpText = text;
  button.setAttribute('aria-label', title + '说明'); button.setAttribute('aria-haspopup', 'dialog');
  button.setAttribute('aria-controls', 'ui-help-popover'); button.setAttribute('aria-expanded', 'false');
  return button;
}

function closeHelpTip(restoreFocus = true) {
  const button = activeHelpButton;
  activeHelpButton = null;
  document.getElementById('ui-help-popover').hidden = true;
  if (button) { button.setAttribute('aria-expanded', 'false'); if (restoreFocus && button.isConnected) button.focus({ preventScroll: true }); }
}

function showHelpTip(button) {
  if (activeHelpButton === button) { closeHelpTip(); return; }
  closeHelpTip(false);
  const panel = document.getElementById('ui-help-popover');
  document.getElementById('ui-help-title').textContent = button.dataset.helpTitle || '说明';
  document.getElementById('ui-help-body').textContent = button.dataset.helpText || '';
  activeHelpButton = button; button.setAttribute('aria-expanded', 'true');
  const viewport = window.visualViewport;
  const area = { left: viewport?.offsetLeft || 0, top: viewport?.offsetTop || 0, width: viewport?.width || innerWidth, height: viewport?.height || innerHeight };
  panel.style.maxHeight = Math.max(100, area.height - 24) + 'px';
  panel.style.maxWidth = Math.max(120, area.width - 24) + 'px';
  panel.style.visibility = 'hidden'; panel.hidden = false;
  const anchor = button.getBoundingClientRect(), width = panel.offsetWidth, height = panel.offsetHeight;
  const left = Math.max(area.left + 12, Math.min(anchor.left, area.left + area.width - width - 12));
  let top = anchor.bottom + 6;
  if (top + height > area.top + area.height - 12) top = anchor.top - height - 6;
  top = Math.max(area.top + 12, Math.min(top, area.top + area.height - height - 12));
  panel.style.left = left + 'px'; panel.style.top = top + 'px'; panel.style.visibility = '';
  panel.focus({ preventScroll: true });
}

document.addEventListener('click', event => {
  const button = event.target instanceof Element ? event.target.closest('button[data-help-text]') : null;
  if (button) { event.preventDefault(); showHelpTip(button); }
  else if (event.target instanceof Element && event.target.closest('#ui-help-close')) closeHelpTip();
});
document.addEventListener('pointerdown', event => {
  if (!activeHelpButton || !(event.target instanceof Node)) return;
  const panel = document.getElementById('ui-help-popover');
  if (!panel.contains(event.target) && !activeHelpButton.contains(event.target) && !(event.target instanceof Element && event.target.closest('button[data-help-text]'))) closeHelpTip(false);
});
document.addEventListener('keydown', event => {
  if (activeHelpButton && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeHelpTip(); }
});
document.addEventListener('scroll', event => {
  if (activeHelpButton && !document.getElementById('ui-help-popover').contains(event.target)) closeHelpTip(false);
}, true);
window.addEventListener('resize', () => closeHelpTip(false));
