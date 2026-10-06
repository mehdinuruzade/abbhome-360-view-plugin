import '../src/widget/index';
import type { ApartmentEventDetail } from '../src/widget/index';

/** Every widget event, kept for the e2e tests. */
declare global {
  interface Window {
    hostEvents: { type: string; detail: unknown }[];
  }
}
window.hostEvents = [];

const widget = document.getElementById('building') as HTMLElementTagNameMap['abb-building-360'];
const log = document.getElementById('log') as HTMLOListElement;
const selection = document.getElementById('selection') as HTMLDivElement;

function record(type: string, detail: unknown) {
  window.hostEvents.push({ type, detail });
  if (type === 'apartment-hover') return; // too chatty for the on-screen log
  const item = document.createElement('li');
  const name = document.createElement('code');
  name.textContent = type;
  item.append(name, ` ${detail ? JSON.stringify(detail) : ''}`);
  log.prepend(item);
  while (log.children.length > 12) log.lastElementChild?.remove();
}

for (const type of ['ready', 'error', 'apartment-hover', 'apartment-preview', 'apartment-select']) {
  widget.addEventListener(type, (e) => record(type, (e as CustomEvent).detail));
}

widget.addEventListener('apartment-select', (e) => {
  const d = (e as CustomEvent<ApartmentEventDetail>).detail;
  const a = widget.building?.apartments.find((x) => x.id === d.apartmentId);
  selection.replaceChildren();
  const title = document.createElement('p');
  title.className = 'big';
  title.textContent = `Apartment ${d.number}`;
  const meta = document.createElement('p');
  meta.className = 'muted';
  meta.textContent = [`Floor ${d.floor}`, a?.rooms ? `${a.rooms} rooms` : '', a?.areaM2 ? `${a.areaM2} m²` : '']
    .filter(Boolean)
    .join(' · ');
  const note = document.createElement('p');
  note.className = 'small';
  note.textContent = 'This is where the host site takes over: its listing page, mortgage calculator or lead form.';
  selection.append(title, meta, note);
});

const actions: Record<string, () => void> = {
  open: () => widget.openApartment('apt-1203'),
  available: () => widget.setFilter({ status: ['available'] }),
  'three-rooms': () => widget.setFilter({ rooms: [3] }),
  clear: () => widget.setFilter(null),
  sell: () => widget.setApartments([{ id: 'apt-1203', status: 'sold' }]),
};
document.querySelectorAll<HTMLButtonElement>('[data-action]').forEach((button) => {
  button.addEventListener('click', () => actions[button.dataset.action ?? '']?.());
});
