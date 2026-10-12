import { loadChunk } from '@/lib/chunk';
import { type ReactNode, useEffect, useState } from 'react';

/**
 * QR-код одного размера во всей панели: квадрат 400px на широком экране, на мобиле - во всю
 * ширину окна. Картинка строится крупно (целое число пикселей на модуль) и показывается без
 * сглаживания: плотные коды (конфиги AWG, кадры vpn://) иначе не читаются камерой. Белый фон -
 * тёмный код на тёмной теме камера не видит. По центру родителя (mx-auto, self-center): в окне
 * с растянутыми строками код иначе прижимался влево. note - подпись под кодом.
 */
export function QrCode({
  text,
  alt,
  level = 'M',
  note,
}: {
  text: string;
  alt: string;
  level?: 'L' | 'M';
  note?: ReactNode;
}) {
  const [url, setUrl] = useState<string | null>(null);
  // прежний код виден, пока строится новый: кадры vpn:// листаются без мигания
  useEffect(() => {
    let alive = true;
    // библиотека QR - отдельным куском, по первому коду: на большинстве страниц кодов нет
    loadChunk(() => import('qrcode'))
      .then((m) =>
        m.default.toDataURL(text, { margin: 1, width: 1200, errorCorrectionLevel: level }),
      )
      .then((u) => alive && setUrl(u))
      .catch(() => alive && setUrl(''));
    return () => {
      alive = false;
    };
  }, [text, level]);
  return (
    <div className="mx-auto flex w-full flex-col items-center gap-2 self-center md:w-[400px]">
      <div className="flex aspect-square w-full items-center justify-center rounded-lg bg-white p-2">
        {url ? (
          <img src={url} alt={alt} className="size-full [image-rendering:pixelated]" />
        ) : (
          url === '' && (
            <span className="px-4 text-center text-xs text-black">не помещается в QR</span>
          )
        )}
      </div>
      {note}
    </div>
  );
}
