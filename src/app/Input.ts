// Lightweight input state. Read each frame by Game.

export class Input {
  readonly keys = new Set<string>();
  mouseX = -1;
  mouseY = -1;
  rmbDown = false;
  rmbDx = 0;
  rmbDy = 0;
  private rmbAccDx = 0;
  private rmbAccDy = 0;
  wheel = 0;
  private wheelAcc = 0;

  attach(el: HTMLElement | Window): void {
    el.addEventListener('keydown', (e: Event) => { this.keys.add((e as KeyboardEvent).code); });
    el.addEventListener('keyup', (e: Event) => { this.keys.delete((e as KeyboardEvent).code); });
    el.addEventListener('mousemove', (e: Event) => {
      const me = e as MouseEvent;
      this.mouseX = me.clientX;
      this.mouseY = me.clientY;
      if (this.rmbDown) { this.rmbAccDx += me.movementX; this.rmbAccDy += me.movementY; }
    });
    el.addEventListener('mousedown', (e: Event) => {
      const me = e as MouseEvent;
      if (me.button === 2) { this.rmbDown = true; me.preventDefault(); }
    });
    el.addEventListener('mouseup', (e: Event) => {
      const me = e as MouseEvent;
      if (me.button === 2) this.rmbDown = false;
    });
    el.addEventListener('contextmenu', (e: Event) => { e.preventDefault(); });
    el.addEventListener('wheel', (e: Event) => {
      this.wheelAcc += (e as WheelEvent).deltaY;
      e.preventDefault();
    }, { passive: false } as AddEventListenerOptions);
    el.addEventListener('blur', () => { this.keys.clear(); });
  }

  /** Call once per frame to snapshot accumulated values. */
  beginFrame(): void {
    this.rmbDx = this.rmbAccDx;
    this.rmbDy = this.rmbAccDy;
    this.rmbAccDx = 0;
    this.rmbAccDy = 0;
    this.wheel = this.wheelAcc;
    this.wheelAcc = 0;
  }
}
