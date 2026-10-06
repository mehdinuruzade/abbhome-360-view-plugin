import { html, nothing, type TemplateResult } from 'lit';
import { statusColor } from '../core/apartments';
import type { Apartment } from '../core/types';
import { formatArea, formatPrice, statusKey, t } from './i18n';

export interface DetailsContext {
  locale: string;
  selectable: boolean;
  onClose: () => void;
  onSelect: () => void;
}

export function renderDetails(a: Apartment, ctx: DetailsContext): TemplateResult {
  const { locale } = ctx;
  const status = t(locale, statusKey(a.status));
  const title = t(locale, 'apartment', { number: a.number });
  return html`
    <section class="panel" role="dialog" aria-label=${title}>
      <header class="panel-head">
        <div>
          <p class="eyebrow">${t(locale, 'floorN', { floor: a.floor })}</p>
          <h2>${title}</h2>
        </div>
        <button class="icon" type="button" aria-label=${t(locale, 'close')} @click=${ctx.onClose}>
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 3.5l9 9m0-9l-9 9" /></svg>
        </button>
      </header>
      <span class="badge" style="--status:${statusColor(a.status)}">${status}</span>
      <div class="body ${a.planImage ? '' : 'no-plan'}">
        ${a.planImage
          ? html`<img class="plan" src=${a.planImage} alt=${t(locale, 'planAlt', { number: a.number })} />`
          : nothing}
        <dl class="facts">
          <div><dt>${t(locale, 'rooms')}</dt><dd>${a.rooms ?? '—'}</dd></div>
          <div><dt>${t(locale, 'area')}</dt><dd>${a.areaM2 !== undefined ? formatArea(a.areaM2, locale) : '—'}</dd></div>
          <div><dt>${t(locale, 'floor')}</dt><dd>${a.floor}</dd></div>
          <div>
            <dt>${t(locale, 'price')}</dt>
            <dd>${a.price ? formatPrice(a.price, locale) : t(locale, 'priceOnRequest')}</dd>
          </div>
        </dl>
      </div>
      <button class="primary" type="button" ?disabled=${!ctx.selectable} @click=${ctx.onSelect}>
        ${ctx.selectable ? t(locale, 'select') : status}
      </button>
    </section>
  `;
}
