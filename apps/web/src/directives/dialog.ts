import type { ObjectDirective } from 'vue';

// Only the topmost modal owns focus; nested previews restore their opener.
const stack: HTMLElement[] = [];
const records = new WeakMap<HTMLElement, { close: () => void; cleanup: () => void }>();
const focusable = (root: HTMLElement) =>
  Array.from(
    root.querySelectorAll<HTMLElement>('button, input, select, textarea, a[href], [tabindex]'),
  ).filter(
    (el) => !el.hasAttribute('disabled') && el.tabIndex >= 0 && el.getClientRects().length > 0,
  );

function attach(el: HTMLElement, close: () => void) {
  const opener = document.activeElement as HTMLElement | null;
  el.tabIndex = -1;
  stack.push(el);
  const record = { close, cleanup: () => {} };
  const focus = () => (focusable(el)[0] ?? el).focus({ preventScroll: true });
  const key = (event: KeyboardEvent) => {
    if (stack.at(-1) !== el) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopImmediatePropagation();
      record.close();
    }
    if (event.key === 'Tab') {
      const nodes = focusable(el),
        first = nodes[0],
        last = nodes.at(-1);
      if (!first) {
        event.preventDefault();
        el.focus();
      } else if (
        !el.contains(document.activeElement) ||
        (!event.shiftKey && document.activeElement === last)
      ) {
        event.preventDefault();
        first.focus();
      } else if (
        event.shiftKey &&
        (document.activeElement === first || document.activeElement === el)
      ) {
        event.preventDefault();
        last!.focus();
      }
    }
  };
  const keepInside = (event: FocusEvent) => {
    if (stack.at(-1) === el && !el.contains(event.target as Node)) focus();
  };
  document.addEventListener('keydown', key, true);
  document.addEventListener('focusin', keepInside);
  queueMicrotask(() => {
    if (el.isConnected && stack.at(-1) === el) focus();
  });
  record.cleanup = () => {
    document.removeEventListener('keydown', key, true);
    document.removeEventListener('focusin', keepInside);
    stack.splice(stack.indexOf(el), 1);
    if (opener?.isConnected) opener.focus({ preventScroll: true });
    else stack.at(-1)?.focus({ preventScroll: true });
  };
  records.set(el, record);
}
function detach(el: HTMLElement) {
  records.get(el)?.cleanup();
  records.delete(el);
}
export const dialog: ObjectDirective<HTMLElement, (() => void) | undefined> = {
  mounted(el, binding) {
    if (binding.value) attach(el, binding.value);
  },
  updated(el, binding) {
    const record = records.get(el);
    if (!binding.value) {
      if (record) detach(el);
    } else if (record) record.close = binding.value;
    else attach(el, binding.value);
  },
  unmounted: detach,
};
