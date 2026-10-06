import { LitElement, css, html } from 'lit';
import { live } from 'lit/directives/live.js';
import { currencyDigits } from '../core/apartments';
import { KNOWN_STATUSES, type Apartment, type ApartmentPatch } from '../core/types';

export interface ApartmentChangeDetail {
  id: string;
  patch: Omit<ApartmentPatch, 'id'>;
}

const DEFAULT_CURRENCY = 'AZN';

/** Empty → undefined (clears the field); anything else must be a number, or the edit is refused. */
function parseOptional(text: string): { ok: true; value: number | undefined } | { ok: false } {
  const t = text.trim();
  if (!t) return { ok: true, value: undefined };
  const n = Number(t.replace(',', '.'));
  return Number.isFinite(n) ? { ok: true, value: n } : { ok: false };
}

/** Inline editing of apartment data. */
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

  /** A numeric field: refused input snaps back to the stored value (inputs are bound with live()). */
  private changeNumber(a: Apartment, key: 'rooms' | 'areaM2', e: Event) {
    const parsed = parseOptional((e.target as HTMLInputElement).value);
    if (parsed.ok) this.change(a.id, { [key]: parsed.value });
    else this.requestUpdate();
  }

  /** Prices are typed in whole units of the row's currency and stored in its minor unit. */
  private changePrice(a: Apartment, e: Event) {
    const parsed = parseOptional((e.target as HTMLInputElement).value);
    if (!parsed.ok) {
      this.requestUpdate();
      return;
    }
    const currency = a.price?.currency ?? this.defaultCurrency();
    this.change(a.id, {
      price: parsed.value === undefined ? undefined : { amountMinor: Math.round(parsed.value * 10 ** currencyDigits(currency)), currency },
    });
  }

  /** Changing the currency keeps the amount as typed (e.g. 120 000 AZN → 120 000 USD). */
  private changeCurrency(a: Apartment, e: Event) {
    const currency = (e.target as HTMLInputElement).value.trim().toUpperCase();
    if (!a.price || !/^[A-Z]{3}$/.test(currency) || currency === a.price.currency) {
      this.requestUpdate();
      return;
    }
    const whole = a.price.amountMinor / 10 ** currencyDigits(a.price.currency);
    this.change(a.id, { price: { amountMinor: Math.round(whole * 10 ** currencyDigits(currency)), currency } });
  }

  private defaultCurrency(): string {
    return this.apartments.find((x) => x.price)?.price?.currency ?? DEFAULT_CURRENCY;
  }

  private requestDelete(id: string) {
    this.dispatchEvent(new CustomEvent('apartment-delete', { detail: { id }, bubbles: true, composed: true }));
  }

  protected override render() {
    if (this.apartments.length === 0) return html`<p class="empty">No apartments yet. Create them in step 7.</p>`;
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
                <td><input aria-label="Number" .value=${live(a.number)} @change=${(e: Event) => {
                  const number = (e.target as HTMLInputElement).value.trim();
                  if (number) this.change(a.id, { number });
                  else this.requestUpdate();
                }} /></td>
                <td class="ro">${a.floor}</td>
                <td><input aria-label="Rooms" inputmode="numeric" .value=${live(a.rooms?.toString() ?? '')} @change=${(e: Event) => this.changeNumber(a, 'rooms', e)} /></td>
                <td><input aria-label="Area" inputmode="decimal" .value=${live(a.areaM2?.toString() ?? '')} @change=${(e: Event) => this.changeNumber(a, 'areaM2', e)} /></td>
                <td>
                  <input
                    aria-label="Price"
                    inputmode="decimal"
                    .value=${live(a.price ? String(a.price.amountMinor / 10 ** currencyDigits(a.price.currency)) : '')}
                    @change=${(e: Event) => this.changePrice(a, e)}
                  />
                </td>
                <td>
                  <input
                    aria-label="Currency"
                    class="short"
                    maxlength="3"
                    ?disabled=${!a.price}
                    title=${a.price ? 'Currency of this price' : 'Enter a price first'}
                    .value=${live(a.price?.currency ?? this.defaultCurrency())}
                    @change=${(e: Event) => this.changeCurrency(a, e)}
                  />
                </td>
                <td>
                  <select aria-label="Status" @change=${(e: Event) => this.change(a.id, { status: (e.target as HTMLSelectElement).value })}>
                    ${[...new Set([...KNOWN_STATUSES, a.status])].map((s) => html`<option value=${s} ?selected=${s === a.status}>${s}</option>`)}
                  </select>
                </td>
                <td><input aria-label="Plan image URL" class="wide" .value=${live(a.planImage ?? '')} @change=${(e: Event) => this.change(a.id, { planImage: (e.target as HTMLInputElement).value.trim() || undefined })} /></td>
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
