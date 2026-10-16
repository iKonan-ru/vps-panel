package adapters

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"path"
	"regexp"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"
)

// Управление клиентами AWG: пир в конфиге сервера и запись в clientsTable - в формате
// приложения Amnezia и AWP, чтобы они видели те же изменения. На каждый контейнер -
// блокировка; перед записью - копии файлов (.panel-bak - прошлая версия, .panel-orig -
// до первого изменения панелью); запись атомарная; syncconf с проверкой, при ошибке
// конфиг откатывается.

// AwgRequest - операция над клиентом экземпляра.
type AwgRequest struct {
	Op        string            `json:"op"`
	Container string            `json:"container"`
	Args      map[string]string `json:"args"`
}

var (
	reWgKey = regexp.MustCompile(`^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$`)
	// пусто - не указано; список совпадает с DEVICES в packages/protocol
	reAwgDevice = regexp.MustCompile(`^(android|ios|windows|macos|linux|router|other)?$`)
	awgLocks    sync.Map                    // контейнер -> *sync.Mutex
	awgTimeFt   = "Mon Jan 2 15:04:05 2006" // как QDateTime::toString() в приложении
)

func awgLock(container string) func() {
	m, _ := awgLocks.LoadOrStore(container, &sync.Mutex{})
	mu := m.(*sync.Mutex)
	mu.Lock()
	return mu.Unlock
}

func validClientName(s string) bool {
	if s == "" || utf8.RuneCountInString(s) > 64 || !utf8.ValidString(s) {
		return false
	}
	for _, r := range s {
		if unicode.IsControl(r) {
			return false
		}
	}
	return true
}

// AwgExec выполняет операцию и возвращает её итог (для client.add - выданный IP).
func AwgExec(ctx context.Context, req AwgRequest) (map[string]any, error) {
	if !reAwgContainer.MatchString(req.Container) {
		return nil, errors.New("неверное имя контейнера")
	}
	if req.Op == "instance.setparams" {
		return awgSetParams(ctx, req)
	}
	key := req.Args["publicKey"]
	if !reWgKey.MatchString(key) {
		return nil, errors.New("неверный публичный ключ клиента")
	}
	name := strings.TrimSpace(req.Args["name"])
	// устройство клиента (список в панели); приложение Amnezia чужие поля userData сохраняет
	device, setDevice := req.Args["device"]
	switch req.Op {
	case "client.add", "client.rename":
		if !validClientName(name) {
			return nil, errors.New("имя: от 1 до 64 символов, без управляющих")
		}
		if !reAwgDevice.MatchString(device) {
			return nil, errors.New("неизвестное устройство: " + device)
		}
	case "client.remove", "client.disable", "client.enable":
	default:
		return nil, errors.New("операция не поддерживается: " + req.Op)
	}

	defer awgLock(req.Container)()
	c := req.Container
	confPath, conf := readAwgConf(ctx, c)
	if confPath == "" {
		return nil, errors.New("не найден конфиг AWG в контейнере " + c)
	}
	iface := strings.TrimSuffix(path.Base(confPath), ".conf")
	tablePath := path.Join(awgDir, "clientsTable")
	// нет файла - пустая таблица (наша установка его не создаёт); другая ошибка чтения - стоп
	tableText := ""
	if text, ok := dexec(ctx, c, "cat", tablePath); ok {
		tableText = text
	} else if _, exists := dexec(ctx, c, "test", "-e", tablePath); exists {
		return nil, errors.New("clientsTable не читается: " + firstLine(text))
	}
	table, err := loadTable(tableText)
	if err != nil {
		// битую таблицу не перезаписываем: так AWP теряла клиентов
		return nil, fmt.Errorf("clientsTable не разобран, изменения отменены: %w", err)
	}
	psk := awgPSK(ctx, c)

	newConf, result := conf, map[string]any{"ok": true}
	switch req.Op {
	case "client.add":
		if _, peers := parseAwgConf(conf); hasPeer(peers, key) || tableIndex(table, key) >= 0 {
			return nil, errors.New("клиент с таким ключом уже есть")
		}
		ip, err := nextAwgIP(conf, table)
		if err != nil {
			return nil, err
		}
		ips := ip + "/32"
		newConf = appendPeer(conf, key, psk, ips)
		ud := map[string]any{
			"clientName": name, "creationDate": time.Now().Format(awgTimeFt), "allowed_ips": ips, "clientIp": ip,
		}
		if device != "" {
			ud["device"] = device
		}
		table = append(table, map[string]any{"clientId": key, "userData": ud})
		result["ip"] = ip
	case "client.remove":
		var removed bool
		newConf, removed = removePeer(conf, key)
		i := tableIndex(table, key)
		if !removed && i < 0 {
			return nil, errors.New("клиент не найден")
		}
		if i >= 0 {
			table = append(table[:i], table[i+1:]...)
		}
	case "client.disable":
		_, peers := parseAwgConf(conf)
		ips := peers[key]
		var removed bool
		if newConf, removed = removePeer(conf, key); !removed {
			return nil, errors.New("клиент уже выключен или не найден")
		}
		ud := userData(&table, key)
		ud["enabled"] = false
		// IP остаётся за клиентом: при включении он вернётся на тот же адрес
		if ips != "" {
			ud["allowed_ips"] = ips
			ud["clientIp"] = strings.TrimSuffix(strings.Split(ips, ",")[0], "/32")
		}
	case "client.enable":
		if _, peers := parseAwgConf(conf); hasPeer(peers, key) {
			return nil, errors.New("клиент уже включён")
		}
		i := tableIndex(table, key)
		if i < 0 {
			return nil, errors.New("нет записи клиента в clientsTable: неизвестен его IP")
		}
		ud := userData(&table, key)
		ips := tableIPs(ud)
		if ips == "" {
			return nil, errors.New("в записи клиента нет IP")
		}
		if ipTaken(conf, strings.TrimSuffix(strings.Split(ips, ",")[0], "/32")) {
			return nil, errors.New("IP клиента уже занят другим пиром")
		}
		if p, ok := ud["psk"].(string); ok && p != "" {
			psk = p // AWP хранила PSK выключенного клиента в записи
		}
		newConf = appendPeer(conf, key, psk, ips)
		ud["enabled"] = true
	case "client.rename":
		ud := userData(&table, key)
		ud["clientName"] = name
		if setDevice {
			if device == "" {
				delete(ud, "device")
			} else {
				ud["device"] = device
			}
		}
	}

	files := []string{tablePath}
	if newConf != conf {
		files = append(files, confPath)
	}
	if err := awgBackup(ctx, c, files...); err != nil {
		return nil, err
	}
	if newConf != conf {
		if err := awgWrite(ctx, c, confPath, newConf, "600"); err != nil {
			return nil, err
		}
		tool := awgTool(ctx, c)
		if msg, ok := dexec(ctx, c, "bash", "-c",
			`t=$(mktemp) && "$1-quick" strip "$2" > "$t" && "$1" syncconf "$3" "$t"; rc=$?; rm -f "$t"; exit $rc`,
			"_", tool, confPath, iface); !ok {
			// живой интерфейс не принял - возвращаем прежний файл, чтобы они не разошлись
			_ = awgWrite(ctx, c, confPath, conf, "600")
			return nil, errors.New("syncconf не применился, конфиг возвращён: " + firstLine(msg))
		}
	}
	b, err := json.MarshalIndent(table, "", "    ")
	if err != nil {
		return nil, err
	}
	if err := awgWrite(ctx, c, tablePath, string(b)+"\n", "600"); err != nil {
		return nil, err
	}
	return result, nil
}

// awgBackup: .panel-orig - копия до первого изменения панелью, .panel-bak - прошлая версия.
func awgBackup(ctx context.Context, container string, files ...string) error {
	args := append([]string{"exec", container, "sh", "-c",
		`for f in "$@"; do [ -e "$f" ] || continue; [ -e "$f.panel-orig" ] || cp -p "$f" "$f.panel-orig" || exit 1; cp -p "$f" "$f.panel-bak" || exit 1; done`,
		"_"}, files...)
	res, err := awgDocker(ctx, 20*time.Second, nil, args...)
	if err != nil || res.ExitCode != 0 {
		return errors.New("не удалось сделать копию перед изменением: " + firstLine(res.Stderr, res.Stdout))
	}
	return nil
}

// awgWrite пишет файл в контейнер атомарно: во временный рядом, затем mv.
func awgWrite(ctx context.Context, container, file, content, mode string) error {
	res, err := awgDocker(ctx, 20*time.Second, &content, "exec", "-i", container, "sh", "-c",
		`t="$1.panel-tmp" && cat > "$t" && chmod "$2" "$t" && mv "$t" "$1"`, "_", file, mode)
	if err != nil || res.ExitCode != 0 {
		return fmt.Errorf("запись %s: %s", file, firstLine(res.Stderr, res.Stdout))
	}
	return nil
}

// AwgConfigData - всё для клиентского конфига одного клиента: параметры интерфейса сервера
// (с HeaderProtectionKey, без PrivateKey сервера), ключ сервера, PSK, IP клиента. Приватный
// ключ клиента хранит панель. Уходит только панели, в браузер - готовый конфиг.
func AwgConfigData(ctx context.Context, req AwgRequest) (map[string]any, error) {
	if !reAwgContainer.MatchString(req.Container) {
		return nil, errors.New("неверное имя контейнера")
	}
	key := req.Args["publicKey"]
	if !reWgKey.MatchString(key) {
		return nil, errors.New("неверный публичный ключ клиента")
	}
	inst := awgInstance(ctx, req.Container, "running")
	if inst.Error != "" {
		return nil, errors.New(inst.Error)
	}
	var client *AwgClient
	for i := range inst.Clients {
		if inst.Clients[i].PublicKey == key {
			client = &inst.Clients[i]
		}
	}
	if client == nil {
		return nil, errors.New("клиент не найден на сервере")
	}
	psk := awgPSK(ctx, req.Container)
	// свой PSK выключенного клиента AWP хранила в записи clientsTable
	if table, err := loadTable(inst.table); err == nil {
		if i := tableIndex(table, key); i >= 0 {
			if ud, ok := table[i]["userData"].(map[string]any); ok {
				if p, _ := ud["psk"].(string); p != "" {
					psk = p
				}
			}
		}
	}
	// PSK пира в конфиге сервера точнее файла: AWP и ручные правки могли дать свой
	if p := peerPSK(inst.conf, key); p != "" {
		psk = p
	}
	return map[string]any{
		"version": inst.Version, "port": inst.Port, "address": inst.Address, "params": inst.Params,
		"serverPublicKey": inst.PublicKey, "psk": psk, "clientIps": client.AllowedIPs,
		"clientName": client.Name,
	}, nil
}
