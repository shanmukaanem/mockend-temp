import { mountButtonStrip } from './split-buttons.mjs'

/** Give each tab strip its own CSS anchor; pointer motion never changes tab selection. */
export function mountTabSliders() {
  document.querySelectorAll('.workspace-tabs').forEach(bar => {
    mountButtonStrip(bar)
    bar.classList.add('sliding-tabs')
    bar.dataset.pointerMotion = ''
    bar.addEventListener('pointerenter', event => {
      if (event.pointerType !== 'touch') bar.dataset.pointerMotion = ''
    })
    bar.addEventListener('keydown', () => { delete bar.dataset.pointerMotion })
    bar.addEventListener('click', event => { if (event.detail === 0) delete bar.dataset.pointerMotion })
  })
}
