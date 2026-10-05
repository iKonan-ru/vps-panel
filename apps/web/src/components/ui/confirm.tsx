import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { type ReactNode, createContext, useCallback, useContext, useMemo, useState } from 'react';

interface ConfirmOptions {
  title: string;
  text?: ReactNode;
  /** Подпись кнопки подтверждения; по умолчанию "Подтвердить". */
  okLabel?: string;
  /** Опасное действие: красная кнопка. */
  danger?: boolean;
}

type Ask = (opts: ConfirmOptions | string) => Promise<boolean>;

const Ctx = createContext<Ask | null>(null);

/** Диалог подтверждения вместо window.confirm: единый вид, Esc и клик мимо = отмена. */
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<{
    opts: ConfirmOptions;
    resolve: (v: boolean) => void;
  } | null>(null);
  const ask = useCallback<Ask>(
    (o) =>
      new Promise<boolean>((resolve) => {
        const opts = typeof o === 'string' ? { title: o } : o;
        setState({ opts, resolve });
      }),
    [],
  );
  const close = (v: boolean) => {
    state?.resolve(v);
    setState(null);
  };
  const value = useMemo(() => ask, [ask]);
  return (
    <Ctx.Provider value={value}>
      {children}
      <Dialog open={state !== null} onClose={() => close(false)} title={state?.opts.title ?? ''}>
        {state?.opts.text && <div className="text-sm text-muted">{state.opts.text}</div>}
        <div className="flex justify-end gap-2">
          <Button onClick={() => close(false)}>Отмена</Button>
          <Button
            variant={state?.opts.danger ? 'danger' : 'primary'}
            autoFocus
            onClick={() => close(true)}
          >
            {state?.opts.okLabel ?? 'Подтвердить'}
          </Button>
        </div>
      </Dialog>
    </Ctx.Provider>
  );
}

export function useConfirm(): Ask {
  const ask = useContext(Ctx);
  if (!ask) throw new Error('useConfirm вне ConfirmProvider');
  return ask;
}
