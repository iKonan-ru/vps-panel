import { CountrySelect } from '@/components/country-select';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { DATE_MAX, DATE_MIN, clampInt, moneyMask } from '@/lib/masks';
import type { Hosting } from '@vps/protocol';

/** Состояние формы хостинга: всё строками, как в полях ввода. */
export interface HostingForm {
  provider: string;
  providerUrl: string;
  providerServerName: string;
  country: string;
  price: string;
  currency: string;
  billingMonths: string;
  nextPaymentAt: string;
  notes: string;
}

export const emptyHostingForm: HostingForm = {
  provider: '',
  providerUrl: '',
  providerServerName: '',
  country: '',
  price: '',
  currency: 'RUB',
  billingMonths: '1',
  nextPaymentAt: '',
  notes: '',
};

export function hostingToForm(h: Hosting): HostingForm {
  return {
    provider: h.provider,
    providerUrl: h.providerUrl,
    providerServerName: h.providerServerName,
    country: h.country,
    price: h.price === null ? '' : String(h.price),
    currency: h.currency,
    billingMonths: String(h.billingMonths || 1),
    nextPaymentAt: h.nextPaymentAt ? h.nextPaymentAt.slice(0, 10) : '',
    notes: h.notes,
  };
}

export function formToHosting(f: HostingForm): Hosting {
  return {
    provider: f.provider.trim(),
    providerUrl: f.providerUrl.trim(),
    providerServerName: f.providerServerName.trim(),
    country: f.country,
    price: f.price.trim() === '' ? null : Number(f.price),
    currency: f.currency,
    billingMonths: Math.min(120, Math.max(1, Number(f.billingMonths) || 1)),
    nextPaymentAt: f.nextPaymentAt ? `${f.nextPaymentAt}T00:00:00.000Z` : null,
    notes: f.notes.trim(),
  };
}

const PERIODS = [
  { v: '1', t: 'ежемесячно' },
  { v: '3', t: 'раз в 3 месяца' },
  { v: '6', t: 'раз в полгода' },
  { v: '12', t: 'раз в год' },
];

/** Поля формы хостинга; сетка 2 колонки на широком экране. */
export function HostingFields({
  f,
  set,
  idPrefix = 'h',
}: { f: HostingForm; set: (patch: Partial<HostingForm>) => void; idPrefix?: string }) {
  const id = (k: string) => `${idPrefix}-${k}`;
  const custom = !PERIODS.some((p) => p.v === f.billingMonths);
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label="Провайдер" htmlFor={id('provider')}>
        <Input
          id={id('provider')}
          value={f.provider}
          onChange={(e) => set({ provider: e.target.value })}
          placeholder="Hoster"
          maxLength={64}
        />
      </Field>
      <Field label="Ссылка на панель хостера" htmlFor={id('url')}>
        <Input
          id={id('url')}
          type="url"
          inputMode="url"
          value={f.providerUrl}
          onChange={(e) => set({ providerUrl: e.target.value })}
          placeholder="https://"
          maxLength={200}
        />
      </Field>
      <Field label="Имя сервера у хостера" htmlFor={id('sname')}>
        <Input
          id={id('sname')}
          value={f.providerServerName}
          onChange={(e) => set({ providerServerName: e.target.value })}
          maxLength={64}
        />
      </Field>
      <Field label="Страна" htmlFor={id('country')}>
        <CountrySelect
          id={id('country')}
          value={f.country}
          onChange={(country) => set({ country })}
        />
      </Field>
      <Field label="Цена" htmlFor={id('price')}>
        <div className="flex gap-2">
          <Input
            id={id('price')}
            value={f.price}
            onChange={(e) => set({ price: moneyMask(e.target.value) })}
            inputMode="decimal"
            placeholder="0"
            className="min-w-0"
          />
          <Select
            value={f.currency}
            onChange={(e) => set({ currency: e.target.value })}
            aria-label="Валюта"
            className="w-[96px] shrink-0"
          >
            <option value="RUB">руб.</option>
            <option value="EUR">EUR</option>
            <option value="USD">USD</option>
          </Select>
        </div>
      </Field>
      <Field label="Период оплаты" htmlFor={id('period')}>
        <div className="flex gap-2">
          <Select
            id={id('period')}
            value={custom ? 'custom' : f.billingMonths}
            onChange={(e) =>
              set({ billingMonths: e.target.value === 'custom' ? '2' : e.target.value })
            }
            className="min-w-0 grow"
          >
            {PERIODS.map((p) => (
              <option key={p.v} value={p.v}>
                {p.t}
              </option>
            ))}
            <option value="custom">раз в N месяцев</option>
          </Select>
          {custom && (
            <Input
              aria-label="Месяцев"
              value={f.billingMonths}
              onChange={(e) => set({ billingMonths: clampInt(e.target.value, 1, 120) })}
              inputMode="numeric"
              className="w-[72px] shrink-0 text-center"
            />
          )}
        </div>
      </Field>
      <Field label="Следующая оплата" htmlFor={id('next')}>
        <Input
          id={id('next')}
          type="date"
          min={DATE_MIN}
          max={DATE_MAX}
          value={f.nextPaymentAt}
          onChange={(e) => set({ nextPaymentAt: e.target.value })}
        />
      </Field>
      <div className="flex flex-col gap-1.5 sm:col-span-2">
        <Label htmlFor={id('notes')}>Заметки</Label>
        <Textarea
          id={id('notes')}
          value={f.notes}
          onChange={(e) => set({ notes: e.target.value })}
          maxLength={1000}
        />
      </div>
    </div>
  );
}
