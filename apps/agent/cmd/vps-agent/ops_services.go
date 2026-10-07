package main

import (
	"context"
	"errors"

	"github.com/iKonan-ru/vps-panel/apps/agent/internal/adapters"
	"github.com/iKonan-ru/vps-panel/apps/agent/internal/dockerapi"
)

// serviceOps - сервисы на сервере: docker, 3X-UI, WDTT, AmneziaWG, OpenFlux, прокси для браузера
// (naive), MTProxyL и пересылка в Telegram.
func serviceOps() map[string]op {
	return map[string]op{
		"docker.action": typed(func(ctx context.Context, p dockerParams, _ stream) (any, error) {
			if p.ID == "" {
				return nil, errors.New("нужны id и action")
			}
			return done(dockerapi.New().Action(ctx, p.ID, p.Action))
		}),
		"docker.logs": typed(func(ctx context.Context, p dockerParams, _ stream) (any, error) {
			if p.ID == "" {
				return nil, errors.New("нужен id")
			}
			if p.Tail <= 0 || p.Tail > 5000 {
				p.Tail = 500
			}
			text, err := dockerapi.New().Logs(ctx, p.ID, p.Tail)
			if err != nil {
				return nil, err
			}
			return map[string]any{"text": text}, nil
		}),

		"xui.info": plain(func(ctx context.Context, _ stream) (any, error) {
			return adapters.XuiInfoGet(ctx), nil
		}),
		"xui.set": typed(func(ctx context.Context, p adapters.XuiSet, out stream) (any, error) {
			return adapters.XuiApply(ctx, p, out)
		}),
		"xui.service": typed(func(ctx context.Context, p struct {
			Action string `json:"action"`
		}, out stream) (any, error) {
			return adapters.XuiService(ctx, p.Action, out)
		}),
		"xui.update": plain(func(ctx context.Context, out stream) (any, error) {
			return adapters.XuiUpdate(ctx, out)
		}),
		"xui.token": plain(func(ctx context.Context, _ stream) (any, error) {
			return adapters.XuiToken(ctx)
		}),
		"xui.api": typed(func(ctx context.Context, p adapters.XuiAPIRequest, _ stream) (any, error) {
			return adapters.XuiAPI(ctx, p)
		}),

		"wdtt.api": typed(func(ctx context.Context, p adapters.WdttAPIRequest, _ stream) (any, error) {
			return adapters.WdttAPI(ctx, p)
		}),

		"awg.status": plain(func(ctx context.Context, _ stream) (any, error) {
			return adapters.AwgStatusAll(ctx), nil
		}),
		"awg.config": typed(func(ctx context.Context, p adapters.AwgRequest, _ stream) (any, error) {
			return adapters.AwgConfigData(ctx, p)
		}),
		"awg.exec": typed(func(ctx context.Context, p adapters.AwgRequest, _ stream) (any, error) {
			if p.Op == "" {
				return nil, errors.New("нужна операция op")
			}
			return adapters.AwgExec(ctx, p)
		}),

		"openflux.status": plain(func(ctx context.Context, _ stream) (any, error) {
			return adapters.OfStatus(ctx), nil
		}),
		"openflux.logs": typed(func(ctx context.Context, p struct {
			Channel string `json:"channel"`
			Lines   int    `json:"lines"`
		}, _ stream) (any, error) {
			return adapters.OfLogs(ctx, p.Channel, p.Lines)
		}),
		"openflux.link": typed(func(ctx context.Context, p adapters.OfLinkRequest, _ stream) (any, error) {
			return adapters.OfLink(ctx, p)
		}),
		"openflux.exec": typed(func(ctx context.Context, p adapters.OfRequest, out stream) (any, error) {
			return adapters.OfExec(ctx, p, out)
		}),

		"naive.status": plain(func(ctx context.Context, _ stream) (any, error) {
			return adapters.NaiveStatus(ctx), nil
		}),
		"naive.exec": typed(func(ctx context.Context, p adapters.NaiveRequest, _ stream) (any, error) {
			return adapters.NaiveExec(ctx, p)
		}),

		"mtproxyl.status": plain(func(ctx context.Context, _ stream) (any, error) {
			return adapters.MtStatusAll(ctx), nil
		}),
		"mtproxyl.exec": typed(func(ctx context.Context, p adapters.MtRequest, out stream) (any, error) {
			if p.Op == "" {
				return nil, errors.New("нужна операция op")
			}
			return adapters.MtExec(ctx, p, out)
		}),

		"clients.stats": typed(func(ctx context.Context, p adapters.ClientStatsRequest, _ stream) (any, error) {
			return adapters.ClientStatsAll(ctx, p), nil
		}),

		"telegram.send": typed(func(ctx context.Context, p adapters.TelegramSend, _ stream) (any, error) {
			return adapters.TelegramSendMessage(ctx, p)
		}),
		"telegram.updates": typed(func(ctx context.Context, p struct {
			Token string `json:"token"`
		}, _ stream) (any, error) {
			return adapters.TelegramUpdates(ctx, p.Token)
		}),
	}
}

type dockerParams struct {
	ID     string `json:"id"`
	Action string `json:"action"`
	Tail   int    `json:"tail"`
}
