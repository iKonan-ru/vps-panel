import { CopyText } from '@/components/ui/copy-text';

/** Точное имя для ручного подтверждения; копирование не меняет поле ввода. */
export function CopyName({ name }: { name: string }) {
  return (
    <CopyText
      text={name}
      title={`Скопировать имя ${name}`}
      className="whitespace-pre-wrap break-all text-left"
    />
  );
}
