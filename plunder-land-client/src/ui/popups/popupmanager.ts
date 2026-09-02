import { Container } from 'pixi.js'

export class PopupManager extends Container {
  queue: Container[] = []

  show (value: Container): void {
    this.addChild(value)
    this.queue.push(value)

    value.on('removed', this.hide.bind(this, value))

    this.updateVisibility()
  }

  hide (value: Container): void {
    // splice() without a delete count removes the element and everything after
    // it, and removes the last entry when indexOf returns -1.
    const at = this.queue.indexOf(value)
    if (at >= 0) this.queue.splice(at, 1)

    this.updateVisibility()
  }

  updateVisibility (): void {
    for (let i = 0; i < this.queue.length; i++) {
      this.queue[i].visible = i === this.queue.length - 1
    }
  }
}
