package adapters

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"time"
)

// TelegramSend - отправка сообщения в Telegram с этого сервера: панель может стоять там,
// где api.telegram.org не доступен, тогда она просит агент на другом сервере переслать.
type TelegramSend struct {
	Token  string `json:"token"`
	ChatID string `json:"chatId"`
	Text   string `json:"text"`
}

var reTgToken = regexp.MustCompile(`^[0-9]{5,12}:[A-Za-z0-9_-]{30,60}$`)

// telegramCall - POST к Bot API. Ответ Telegram (даже с ошибкой) возвращается как есть,
// сетевая недоступность - отдельной ошибкой, чтобы панель могла попробовать другой сервер.
func telegramCall(ctx context.Context, token, method string, params map[string]any) (json.RawMessage, error) {
	body, _ := json.Marshal(params)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "https://api.telegram.org/bot"+token+"/"+method, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	cl := &http.Client{Timeout: 20 * time.Second}
	resp, err := cl.Do(req)
	if err != nil {
		// в *url.Error - полный адрес с токеном бота: наружу (в панель и её журнал) только причина
		var ue *url.Error
		if errors.As(err, &ue) {
			err = ue.Err
		}
		return nil, fmt.Errorf("telegram недоступен с этого сервера: %w", err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 256*1024))
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("telegram ответил %d: %s", resp.StatusCode, string(raw))
	}
	return raw, nil
}

func TelegramSendMessage(ctx context.Context, p TelegramSend) (map[string]any, error) {
	if !reTgToken.MatchString(p.Token) || p.ChatID == "" || p.Text == "" {
		return nil, errors.New("нужны токен, chat id и текст")
	}
	_, err := telegramCall(ctx, p.Token, "sendMessage", map[string]any{
		"chat_id": p.ChatID, "text": p.Text, "parse_mode": "HTML", "disable_web_page_preview": true,
	})
	if err != nil {
		return nil, err
	}
	return map[string]any{"ok": true}, nil
}

// TelegramUpdates - getUpdates: кто недавно писал боту (для подбора chat id в настройках).
// Возвращает сырой ответ Telegram, разбирает его панель.
func TelegramUpdates(ctx context.Context, token string) (map[string]any, error) {
	if !reTgToken.MatchString(token) {
		return nil, errors.New("неверный формат токена бота")
	}
	raw, err := telegramCall(ctx, token, "getUpdates", map[string]any{
		"limit": 100, "allowed_updates": []string{"message", "my_chat_member", "channel_post"},
	})
	if err != nil {
		return nil, err
	}
	return map[string]any{"raw": string(raw)}, nil
}
