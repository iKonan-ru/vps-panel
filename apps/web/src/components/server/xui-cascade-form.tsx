import type { EditData } from '@/components/server/xui-edit-inbound';
import {
  FingerprintField,
  PortField,
  TargetField,
  type TargetOption,
  useRealityPicker,
} from '@/components/server/xui-inbound-fields';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Field } from '@/components/ui/field';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { api } from '@/lib/api';
import { useAction } from '@/lib/use-action';
import { useQuery } from '@tanstack/react-query';
import type { CascadeMode, CascadeNewInfo, CascadeTelegramState, CascadeView } from '@vps/protocol';
import { type FormEvent, useEffect, useState } from 'react';

export const MODE_TITLE: Record<CascadeMode, string> = {
  'ru-direct': 'Российское напрямую',
  all: 'Всё через выход',
  blocked: 'Только заблокированное через выход',
};

const MODE_HINT: Record<CascadeMode, string> = {
  'ru-direct':
    'российские сайты и адреса открываются с этого сервера, остальное\u00a0\u2014 с выхода',
  all: 'все сайты видят адрес выхода',
  blocked:
    'через выход\u00a0\u2014 только заблокированное в России (списки runetfreedom), остальное с этого сервера',
};

const MODES: CascadeMode[] = ['ru-direct', 'all', 'blocked'];

const lines = (s: string) =>
  s
    .split('\n')
    .map((x) => x.trim())
    .filter(Boolean);

/**
 * Окно каскада: новый - выход, его inbound, порт и цель Reality входа, режим и списки; правка -
 * режим, списки, QUIC, inbound того же выхода, цель Reality и fingerprint входа (по умолчанию
 * прежние, подбор - по кнопке). Отметка Telegram: MTProxyL этого сервера ходит в Telegram через
 * выход; "основной" - выбор, только если отмечены и другие каскады.
 */
export function CascadeForm({
  serverId,
  cascade,
  telegram,
  telegramOthers,
  disabled,
  onCancel,
  onStarted,
}: {
  serverId: string;
  cascade?: CascadeView;
  telegram: CascadeTelegramState | undefined;
  /** Другие каскады этого входа с отметкой Telegram. */
  telegramOthers: number;
  disabled: boolean;
  onCancel: () => void;
  onStarted: (actionId: string) => void;
}) {
  const editing = Boolean(cascade);
  const info = useQuery({
    queryKey: ['cascade-new', serverId],
    queryFn: () => api<CascadeNewInfo>(`/api/servers/${serverId}/cascades/new`),
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
  const entryInboundId = cascade?.entryPort ? cascade.entryInboundId : null;
  const current = useQuery({
    queryKey: ['xui-inbound-edit', serverId, entryInboundId],
    queryFn: () => api<EditData>(`/api/servers/${serverId}/xui/inbounds/${entryInboundId}/edit`),
    enabled: Boolean(entryInboundId),
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
  const reality = current.data?.reality ?? null;
  const picker = useRealityPicker(serverId, { preset: 'ru', enabled: !editing });
  const scan = picker.scan;
  const d = info.data;
  const [exitId, setExitId] = useState(cascade?.exitServerId ?? '');
  const [inboundId, setInboundId] = useState(cascade ? String(cascade.exitInboundId) : '');
  const [port, setPort] = useState('');
  const [targetKey, setTargetKey] = useState(editing ? 'cur' : '');
  const [fp, setFp] = useState(editing ? '' : 'firefox');
  const [mode, setMode] = useState<CascadeMode>(cascade?.mode ?? 'ru-direct');
  const [direct, setDirect] = useState((cascade?.directList ?? []).join('\n'));
  const [viaExit, setViaExit] = useState((cascade?.exitList ?? []).join('\n'));
  const [quic, setQuic] = useState(cascade?.blockQuic ?? false);
  const [tg, setTg] = useState(cascade?.telegram ?? false);
  const [tgMain, setTgMain] = useState(cascade?.telegramMain ?? false);
  // снять отметку можно всегда; поставить - только если на сервере есть MTProxyL
  const tgBlocked = !cascade?.telegram && telegram?.available === false;
  const act = useAction();

  useEffect(() => {
    if (!d) return;
    if (!editing) setPort(String(d.port));
    const first = d.exits.find((e) => !e.reason);
    setExitId((cur) => cur || first?.serverId || '');
  }, [d, editing]);

  useEffect(() => {
    if (reality) setFp(reality.fingerprint);
  }, [reality]);

  const exit = d?.exits.find((e) => e.serverId === exitId);
  const inbounds = exit?.inbounds ?? [];
  const inb = inbounds.some((i) => String(i.id) === inboundId)
    ? inboundId
    : String(inbounds.find((i) => i.enable)?.id ?? '');
  const options: TargetOption[] = reality
    ? [
        {
          key: 'cur',
          label: `Сейчас: ${reality.target}`,
          target: reality.target,
          serverNames: reality.serverNames,
        },
        ...picker.options,
      ]
    : picker.options;
  const key = options.some((o) => o.key === targetKey) ? targetKey : (options[0]?.key ?? '');
  const target = options.find((o) => o.key === key);
  const portN = Number(port);
  const badPort = !editing && (!Number.isInteger(portN) || portN < 1 || portN > 65535);
  const loading = info.isFetching || picker.busy || current.isFetching;
  const realityEdit: Record<string, unknown> = {};
  if (reality && target && key !== 'cur') {
    realityEdit.target = target.target;
    realityEdit.serverNames = target.serverNames;
  }
  if (reality && fp && fp !== reality.fingerprint) realityEdit.fingerprint = fp;
  const ready =
    !disabled &&
    !act.busy &&
    !loading &&
    Boolean(d?.agentReady) &&
    Boolean(inb) &&
    (editing || Boolean(target)) &&
    !badPort &&
    !(mode === 'blocked' && !d?.geoRu);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!ready) return;
    void act.run(async () => {
      const common = {
        exitInboundId: Number(inb),
        mode,
        directList: lines(direct),
        exitList: lines(viaExit),
        blockQuic: quic,
        telegram: tg,
        telegramMain: tg && (tgMain || telegramOthers === 0),
      };
      const r = cascade
        ? await api<{ actionId: string }>(`/api/cascades/${cascade.id}/edit`, {
            method: 'POST',
            json: { ...common, ...realityEdit },
          })
        : await api<{ actionId: string }>(`/api/servers/${serverId}/cascades`, {
            method: 'POST',
            json: {
              ...common,
              exitServerId: exitId,
              port: portN,
              target: target?.target,
              serverNames: target?.serverNames,
              fingerprint: fp,
            },
          });
      onStarted(r.actionId);
    });
  };

  if (info.error) return <Alert tone="bad">{info.error.message}</Alert>;
  return (
    <form className="flex flex-col gap-4" onSubmit={submit}>
      {d && !d.agentReady && (
        <Alert tone="bad">Агент сервера устарел: для каскада нужно обновить агента</Alert>
      )}
      <Field label="Выход" htmlFor="cascade-exit">
        <Select
          id="cascade-exit"
          value={exitId}
          disabled={editing || !d || act.busy}
          onChange={(e) => {
            setExitId(e.target.value);
            setInboundId('');
          }}
        >
          {!d && <option value="">{info.isFetching ? 'Загрузка\u2026' : 'Нет данных'}</option>}
          {d?.exits.map((x) => (
            <option key={x.serverId} value={x.serverId} disabled={Boolean(x.reason)}>
              {x.reason ? `${x.serverName} (${x.reason})` : x.serverName}
            </option>
          ))}
        </Select>
      </Field>
      {inbounds.length > 1 && (
        <Field label="Inbound выхода" htmlFor="cascade-exit-inbound">
          <Select
            id="cascade-exit-inbound"
            value={inb}
            disabled={act.busy}
            onChange={(e) => setInboundId(e.target.value)}
          >
            {inbounds.map((i) => (
              <option key={i.id} value={i.id} disabled={!i.enable}>
                {`${i.remark || `#${i.id}`}, порт ${i.port}${i.enable ? '' : ' (выключен)'}`}
              </option>
            ))}
          </Select>
        </Field>
      )}
      {editing && current.error && (
        <Alert tone="bad">{`Цель Reality входа не прочитана: ${current.error.message}`}</Alert>
      )}
      {!editing && (
        <PortField
          id="cascade-port"
          serverId={serverId}
          value={port}
          onChange={setPort}
          disabled={!d || act.busy}
          avoid={[]}
        />
      )}
      {(!editing || reality) && (
        <>
          <TargetField
            options={options}
            value={key}
            onChange={setTargetKey}
            scanning={scan.isFetching}
            scanError={scan.error}
            onRescan={picker.rescan}
            disabled={act.busy}
            rescanTitle={editing ? 'Подобрать цель с сервера' : 'Подобрать заново'}
            picker={picker}
          />
          <FingerprintField value={fp} onChange={setFp} disabled={act.busy} />
        </>
      )}
      <Field label="Что идёт через выход" htmlFor="cascade-mode" hint={MODE_HINT[mode]}>
        <Select
          id="cascade-mode"
          value={mode}
          disabled={act.busy}
          onChange={(e) => setMode(e.target.value as CascadeMode)}
        >
          {MODES.map((m) => (
            <option key={m} value={m} disabled={m === 'blocked' && d?.geoRu === false}>
              {m === 'blocked' && d?.geoRu === false
                ? `${MODE_TITLE[m]} (нет списков на сервере)`
                : MODE_TITLE[m]}
            </option>
          ))}
        </Select>
      </Field>
      <Field
        label="Всегда через выход"
        htmlFor="cascade-exit-list"
        hint="по строке: домен (с поддоменами), IP, подсеть или правило Xray (geosite:apple, regexp:\.corp$)"
      >
        <Textarea
          id="cascade-exit-list"
          value={viaExit}
          rows={3}
          placeholder={'example.com\n203.0.113.0/24'}
          disabled={act.busy}
          onChange={(e) => setViaExit(e.target.value)}
          className="font-mono text-xs"
        />
      </Field>
      <Field label="Всегда напрямую" htmlFor="cascade-direct-list">
        <Textarea
          id="cascade-direct-list"
          value={direct}
          rows={3}
          placeholder={'example.org\ngeosite:apple'}
          disabled={act.busy}
          onChange={(e) => setDirect(e.target.value)}
          className="font-mono text-xs"
        />
      </Field>
      <Checkbox
        label="Telegram через этот выход"
        hint={
          tgBlocked
            ? (telegram?.reason ?? 'недоступно')
            : 'MTProxyL этого сервера пойдёт в Telegram через выход; его middle proxy и прямой маршрут выключатся'
        }
        checked={tg}
        disabled={act.busy || tgBlocked}
        onChange={(e) => setTg(e.target.checked)}
      />
      {/* основной снимается выбором другого основного: иначе им снова стал бы этот же */}
      {tg && telegramOthers > 0 && !cascade?.telegramMain && telegram?.balance !== 'even' && (
        <Checkbox
          label="Основной выход Telegram"
          hint={'остальные отмеченные выходы\u00a0\u2014 запасные, на случай отказа основного'}
          checked={tgMain}
          disabled={act.busy}
          onChange={(e) => setTgMain(e.target.checked)}
        />
      )}
      <Checkbox
        label="Блокировать QUIC"
        hint="приложения перейдут с UDP 443 на TCP: помогает, если видео через выход тормозит"
        checked={quic}
        disabled={act.busy}
        onChange={(e) => setQuic(e.target.checked)}
      />
      {act.error && <Alert tone="bad">{act.error}</Alert>}
      {Object.keys(realityEdit).length > 0 && (
        <div className="text-xs text-muted">
          Ссылки клиентов на этот каскад изменятся, подписки обновятся сами; если Xray остановится,
          панель вернёт inbound входа как был
        </div>
      )}
      {!editing && (
        <div className="text-xs text-muted">
          Ссылки через этот сервер появятся в подписках клиентов рядом с прямыми ссылками выхода
        </div>
      )}
      <div className="flex justify-end gap-2">
        <Button onClick={onCancel} disabled={act.busy}>
          Отмена
        </Button>
        <Button type="submit" variant="primary" disabled={!ready}>
          {editing ? 'Сохранить' : 'Добавить'}
        </Button>
      </div>
    </form>
  );
}
