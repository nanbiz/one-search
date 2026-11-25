// Types a text into the page's main text box once the page has it, and sends
// it the way the page takes it: its form, Enter in the box, or the button
// beside the box. Where none of them takes it, the text stays in the box. A pill at the foot of the page shows the text while
// the page gets there, and offers it to copy where no box turns up.
// Run by the worker in the page of the site picked, after text-box.js.
globalThis.oneSearchTypeInto = async (text, waiting, copyIcon, textIcon) => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const contentOf = (element) => (element.value ?? element.innerText ?? '').trim();
  const host = document.createElement('div');
  host.style.cssText = 'all:initial;position:fixed;left:0;right:0;bottom:24px;z-index:2147483647;display:flex;justify-content:center;pointer-events:none';
  const root = host.attachShadow({ mode: 'closed' });
  // Built of elements, as a page can refuse markup given as text.
  root.append(Object.assign(document.createElement('style'), { textContent: '.pill{display:flex;align-items:center;gap:10px;max-width:min(560px,90vw);box-sizing:border-box;padding:9px 14px;border:1px solid #e4e4e7;border-radius:12px;background:#fafafa;color:#27272a;box-shadow:0 8px 30px rgb(0 0 0/.28);font:14px system-ui,sans-serif;pointer-events:auto}'
    + '.text{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}img{width:16px;height:16px;flex:none}'
    + '.spin{flex:none;width:14px;height:14px;box-sizing:border-box;border:2px solid #a1a1aa;border-top-color:#3b6fd6;border-radius:50%;animation:turn 1s linear infinite}@keyframes turn{to{transform:rotate(1turn)}}'
    + 'button{display:flex;align-items:center;gap:6px;flex:none;border:0;border-radius:7px;padding:5px 10px;background:#3b6fd6;color:#fff;font:13px system-ui,sans-serif;cursor:pointer}button img{width:14px;height:14px;filter:brightness(0) invert(1)}'
    + '@media (prefers-color-scheme:dark){.pill{background:#1f1f23;color:#e4e4e7;border-color:#34343a}}' }));
  const pill = document.createElement('div');
  pill.className = 'pill';
  pill.setAttribute('role', 'status');
  const label = Object.assign(document.createElement('span'), { className: 'text', textContent: text });
  pill.append(Object.assign(document.createElement('img'), { src: textIcon, alt: '' }), label, Object.assign(document.createElement('span'), { className: 'spin' }));
  root.append(pill);
  document.documentElement.append(host);

  // What the box holds already, a draft the page kept say, gives way.
  const type = (box) => {
    box.focus();
    if (box.select) box.select();
    else getSelection().selectAllChildren(box);
    document.execCommand('insertText', false, text);
    // A field whose page keeps its own hand on the value.
    if (box.value !== undefined && contentOf(box) !== text) {
      const proto = box instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(box, text);
      box.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    }
  };
  // The page took the text once the box no longer holds it.
  const taken = async (box) => {
    for (let wait = 0; wait < 10; wait++) {
      await sleep(100);
      if (!box.isConnected || !contentOf(box).includes(text)) return true;
    }
    return false;
  };
  const shown = (element) => element.checkVisibility() && element.getBoundingClientRect().width > 0;
  // The button that sends the box: the nearest one around it that names
  // sending, or submits.
  const sendButton = (box) => {
    for (let around = box.parentElement, level = 0; around && level < 6; around = around.parentElement, level++) {
      const button = [...around.querySelectorAll('button, [role=button], input[type=submit]')].find((candidate) => shown(candidate)
        && !candidate.disabled && candidate.getAttribute('aria-disabled') !== 'true'
        && (candidate.type === 'submit' || /\b(send|submit|ask|search|go)\b/i.test(`${candidate.getAttribute('aria-label') ?? ''} ${candidate.title ?? ''} ${candidate.innerText ?? ''} ${candidate.value ?? ''}`)));
      if (button) return button;
    }
    return null;
  };
  const send = async (box) => {
    if (box.form) {
      box.form.requestSubmit();
      if (await taken(box)) return true;
    }
    const enter = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true, composed: true };
    box.dispatchEvent(new KeyboardEvent('keydown', enter));
    box.dispatchEvent(new KeyboardEvent('keypress', enter));
    box.dispatchEvent(new KeyboardEvent('keyup', enter));
    if (await taken(box)) return true;
    const button = sendButton(box);
    if (!button) return false;
    button.click();
    return taken(box);
  };
  const until = Date.now() + waiting;
  let last = null;
  while (Date.now() < until) {
    const box = globalThis.oneSearchTextBox();
    // The same box twice, as a page still starting replaces it.
    if (box && box === last) {
      type(box);
      // A page that takes its box over later empties it again.
      await sleep(700);
      if (box.isConnected && contentOf(box).includes(text)) {
        host.remove();
        return await send(box) ? 'sent' : 'typed';
      }
    }
    last = box;
    await sleep(200);
  }
  const copy = document.createElement('button');
  copy.append(Object.assign(document.createElement('img'), { src: copyIcon, alt: '' }), 'Copy');
  copy.addEventListener('click', async () => {
    await navigator.clipboard.writeText(text);
    host.remove();
  });
  pill.querySelector('.spin').replaceWith(copy);
  setTimeout(() => host.remove(), 30_000);
  return 'offered';
};
