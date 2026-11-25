// The page's main text box: the field a person would type into first, on any
// site. A page that asks for a password has none, as its field is a sign-in.
// Runs in the page before learn-search.js and type-into.js, which use it.
globalThis.oneSearchTextBox ??= () => {
  const fields = [];
  let password = false;
  const look = (root) => {
    for (const element of root.querySelectorAll('*')) {
      if (element.shadowRoot) look(element.shadowRoot);
      if (!element.matches('textarea, input, [contenteditable=""], [contenteditable=true], [contenteditable=plaintext-only]')) continue;
      const box = element.getBoundingClientRect();
      if (box.width < 120 || box.height < 12 || box.bottom <= 0 || box.top >= innerHeight) continue;
      if (!element.checkVisibility({ opacityProperty: false, visibilityProperty: true }) || element.disabled || element.readOnly || element.closest('[inert]')) continue;
      if (element.type === 'password') password = true;
      if (element.matches('input') && !['text', 'search'].includes(element.type)) continue;
      // An editor can hold editable parts of its own.
      if (element.parentElement?.closest('[contenteditable=""], [contenteditable=true], [contenteditable=plaintext-only]')) continue;
      fields.push({ element, area: box.width * box.height });
    }
  };
  look(document);
  if (password || fields.length === 0) return null;
  const largest = (some) => some.reduce((best, field) => (!best || field.area > best.area ? field : best), null)?.element ?? null;
  // Boxes for writing come before lines, search lines before other ones, and
  // another single line counts only where it is the page's only field, as
  // forms are made of those.
  return largest(fields.filter(({ element }) => !element.matches('input')))
    ?? largest(fields.filter(({ element }) => element.type === 'search' || element.matches('[role=searchbox], [role=search] *, [name=q]')))
    ?? (fields.length === 1 ? fields[0].element : null);
};
