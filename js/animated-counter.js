const SEPARATORS = new Set([',', '.', ':']);

export class AnimatedCounter {
  constructor(element, { decimals = 0, format } = {}) {
    this.element = element;
    this.format = format ?? new Intl.NumberFormat('en-US', {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    }).format;
    this.motionPreference = window.matchMedia('(prefers-reduced-motion: reduce)');
    this.slots = [];
    this.value = 0;
    this.accessible = document.createElement('span');
    this.accessible.className = 'sr-only';
    this.visual = document.createElement('span');
    this.visual.className = 'counter-digits';
    this.visual.setAttribute('aria-hidden', 'true');
    element.replaceChildren(this.accessible, this.visual);
    this.motionPreference.addEventListener('change', () => this.set(this.value, { immediate: true }));
    this.set(0, { immediate: true });
  }

  set(value, { immediate = false } = {}) {
    const next = Number.isFinite(value) ? Math.max(0, value) : 0;
    const formatted = this.format(next);
    const direction = next >= this.value ? 1 : -1;
    this.value = next;
    if (formatted === this.element.dataset.value && !immediate) return;
    this.element.dataset.value = formatted;
    this.accessible.textContent = formatted;
    const animate = !immediate && !this.motionPreference.matches;
    const characters = [...formatted].reverse();

    while (this.slots.length > characters.length) {
      const slot = this.slots.pop();
      this.cancel(slot);
      slot.element.remove();
    }
    characters.forEach((character, index) => {
      let slot = this.slots[index];
      if (!slot) {
        const element = document.createElement('span');
        element.className = 'counter-slot';
        slot = { element, character: '', animations: [] };
        this.slots.push(slot);
        this.visual.prepend(element);
      }
      if (slot.character === character && !immediate) return;
      this.cancel(slot);
      const previous = slot.character;
      slot.character = character;
      slot.element.classList.toggle('counter-separator', SEPARATORS.has(character));
      const incoming = document.createElement('span');
      incoming.className = 'counter-glyph';
      incoming.textContent = character;
      slot.element.replaceChildren(incoming);
      if (!animate || !/\d/.test(character)) return;

      const options = { duration: 180, easing: 'cubic-bezier(.22, .7, .25, 1)' };
      slot.animations.push(incoming.animate([
        { transform: `translateY(${direction * 85}%)`, opacity: 0 },
        { transform: 'translateY(0)', opacity: 1 },
      ], options));
      if (previous) {
        const outgoing = document.createElement('span');
        outgoing.className = 'counter-glyph counter-outgoing';
        outgoing.textContent = previous;
        slot.element.appendChild(outgoing);
        const animation = outgoing.animate([
          { transform: 'translateY(0)', opacity: 1 },
          { transform: `translateY(${-direction * 85}%)`, opacity: 0 },
        ], options);
        animation.onfinish = () => outgoing.remove();
        slot.animations.push(animation);
      }
    });
  }

  cancel(slot) {
    for (const animation of slot.animations) animation.cancel();
    slot.animations = [];
  }
}
