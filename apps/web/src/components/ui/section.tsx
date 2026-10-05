import { Card } from '@/components/ui/card';
import { InfoTip } from '@/components/ui/info-tip';
import type { ReactNode } from 'react';

/**
 * Карточка с шапкой: заголовок слева (info - пояснение за иконкой рядом), плашки (extra) за ним,
 * действия справа. Действия - своей колонкой у первой строки: не поместившиеся плашки уходят на
 * строку ниже, а не сдвигают кнопки. extraBelow - на узком экране плашки всегда отдельной строкой
 * под заголовком (когда их несколько и меняется их число).
 */
export function Section({
  title,
  info,
  extra,
  extraBelow,
  actions,
  children,
}: {
  title: ReactNode;
  info?: ReactNode;
  extra?: ReactNode;
  extraBelow?: boolean;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const head = (
    <div className="flex min-h-7.5 min-w-0 items-center gap-1 font-semibold">
      {title}
      {info && <InfoTip>{info}</InfoTip>}
    </div>
  );
  const buttons = actions && (
    <div className="flex min-h-7.5 items-center justify-end gap-2">{actions}</div>
  );
  return (
    <Card className="shrink-0 overflow-hidden">
      {extraBelow ? (
        // узкий экран: заголовок и действия, под ними плашки во всю ширину; широкий - в одну строку
        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-2.5 gap-y-2 border-b border-border px-4 py-3 md:grid-cols-[auto_minmax(0,1fr)_auto]">
          <div className="col-start-1 row-start-1">{head}</div>
          {extra && (
            <div className="col-span-2 row-start-2 flex min-w-0 flex-wrap items-center gap-2.5 md:col-span-1 md:col-start-2 md:row-start-1 md:min-h-7.5">
              {extra}
            </div>
          )}
          {buttons && <div className="col-start-2 row-start-1 md:col-start-3">{buttons}</div>}
        </div>
      ) : (
        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-2.5 border-b border-border px-4 py-3">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-2">
            {head}
            {extra && <div className="flex min-w-0 flex-wrap items-center gap-2.5">{extra}</div>}
          </div>
          {buttons}
        </div>
      )}
      {children}
    </Card>
  );
}
