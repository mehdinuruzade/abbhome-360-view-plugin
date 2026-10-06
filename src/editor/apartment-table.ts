import { LitElement, css, html } from 'lit';
import { KNOWN_STATUSES, type Apartment, type ApartmentPatch } from '../core/types';

export interface ApartmentChangeDetail {
  id: string;
  patch: Omit<ApartmentPatch, 'id'>;
}

const num = (v: string): number | undefined => {
  if (v.trim() === '') return undefined;
  const n = Number(v.replace(',', '.'));
  return Number.isFinite(n) ? n : undefined;
};

/** Inline editing of apartment data. Prices are entered in whole currency units, stored in minor units. */
export class ApartmentTable extends LitElement {
  static override properties = {
    apartments: { attribute: false },
    selected: { attribute: false },
  };

  declare apartments: Apartment[];
  declare selected: string | null;

  constructor() {
    super();
    this.apartments = [];
    this.selected = null;
  }

  private change(id: string, patch: Omit<ApartmentPatch, 'id'>) {
    this.dispatchEvent(
      new CustomEvent<ApartmentChangeDetail>('apartment-change', { detail: { id, patch }, bubbles: true, composed: true }),
    );
  }

  private requestDelete(id: string) {
    this.dispatchEvent(new CustomEvent('apartment-delete', { detail: { id }, bubbles: true, composed: true }));
  }

  protected override render() {
    if (this.apartments.length === 0) return html`<p class="empty">No apartments yet. Create them in step 6.</p>`;
    const rows = [...this.apartments].sort((a, b) => b.floor - a.floor || a.number.localeCompare(b.number, undefined, { numeric: true }));
    return html`
      <div class="scroll">
        <table>
          <thead>
            <tr>
              <th>Number</th>
              <th>Floor</th>
              <th>Rooms</th>
              <th>Area m²</th>
              <th>Price</th>
              <th>Currency</th>
              <th>Status</th>
              <th>Plan image URL</th>
              <th><span class="sr">Delete</span></th>
            </tr>
          </thead>
          <tbody>
            ${rows.map(
              (a) => html`<tr class=${a.id === this.selected ? 'selected' : ''} data-id=${a.id}>
                <td><input aria-label="Number" .value=${a.number} @change=${(e: Event) => this.change(a.id, { number: (e.target as HTMLInputElement).value.trim() || a.number })} /></td>
                <td class="ro">${a.floor}</td>
                <td><input aria-label="Rooms" inputmode="numeric" .value=${a.rooms?.toString() ?? ''} @change=${(e: Event) => this.change(a.id, { rooms: num((e.target as HTMLInputElement).value) })} /></td>
                <td><input aria-label="Area" inputmode="decimal" .value=${a.areaM2?.toString() ?? ''} @change=${(e: Event) => this.change(a.id, { areaM2: num((e.target as HTMLInputElement).value) })} /></td>
                <td>
                  <input
                    aria-label="Price"
                    inputmode="numeric"
                    .value=${a.price ? String(a.price.amountMinor / 100) : ''}
                    @change=${(e: Event) => {
                      const v = num((e.target as HTMLInputElement).value);
                      this.change(a.id, { price: v === undefined ? undefined : { amountMinor: Math.round(v * 100), currency: a.price?.currency ?? 'AZN' } });
                    }}
                  />
                </td>
                <td>
                  <input
                    aria-label="Currency"
                    class="short"
                    maxlength="3"
                    .value=${a.price?.currency ?? 'AZN'}
                    @change=${(e: Event) => {
                      const currency = (e.target as HTMLInputElement).value.trim().toUpperCase();
                      if (a.price && /^[A-Z]{3}$/.test(currency)) this.change(a.id, { price: { ...a.price, currency } });
                    }}
                  />
                </td>
                <td>
                  <select aria-label="Status" @change=${(e: Event) => this.change(a.id, { status: (e.target as HTMLSelectElement).value })}>
                    ${[...new Set([...KNOWN_STATUSES, a.status])].map((s) => html`<option value=${s} ?selected=${s === a.status}>${s}</option>`)}
                  </select>
                </td>
                <td><input aria-label="Plan image URL" class="wide" .value=${a.planImage ?? ''} @change=${(e: Event) => this.change(a.id, { planImage: (e.target as HTMLInputElement).value.trim() || undefined })} /></td>
                <td><button type="button" aria-label="Delete apartment ${a.number}" @click=${() => this.requestDelete(a.id)}>Delete</button></td>
              </tr>`,
            )}
          </tbody>
        </table>
      </div>
    `;
  }

  static override styles = css`
    :host {
      display: block;
    }
    .scroll {
      max-height: 70vh;
      overflow: auto;
      border: 1px solid #dde2e7;
      border-radius: 8px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
    }
    th {
      position: sticky;
      top: 0;
      z-index: 1;
      padding: 8px 6px;
      background: #f3f5f7;
      text-align: left;
      font-weight: 600;
      white-space: nowrap;
    }
    td {
      padding: 4px 6px;
      border-top: 1px solid #eef1f4;
    }
    tr.selected td {
      background: #eef5ff;
    }
    .ro {
      color: #5b6673;
    }
    input,
    select {
      width: 84px;
      padding: 4px 6px;
      border: 1px solid #ccd3da;
      border-radius: 6px;
      font: inherit;
    }
    input.short {
      width: 52px;
    }
    input.wide {
      width: 200px;
    }
    button {
      padding: 4px 8px;
      border: 1px solid #ccd3da;
      border-radius: 6px;
      background: #fff;
      color: #b3261e;
      font: inherit;
      cursor: pointer;
    }
    .sr {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip: rect(0 0 0 0);
    }
    .empty {
      color: #5b6673;
    }
  `;
}

if (!customElements.get('abb360-apartment-table')) customElements.define('abb360-apartment-table', ApartmentTable);
