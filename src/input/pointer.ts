/** Normalized cursor position in [-1, 1], +y up. */
export class Pointer {
  x = 0;
  y = 0;

  constructor() {
    window.addEventListener("pointermove", (e: PointerEvent) => {
      this.x = (e.clientX / window.innerWidth) * 2 - 1;
      this.y = -((e.clientY / window.innerHeight) * 2 - 1);
    });
  }
}
