create table settings (id integer primary key, key text, value text);
insert into settings (key, value) values
  ('webPort', '2053'), ('webListen', ''), ('webCertFile', ''), ('webKeyFile', ''),
  ('webBasePath', '/'), ('twoFactorEnable', 'false'), ('subEnable', 'true'),
  ('subPort', '2096'), ('subListen', ''), ('tgBotEnable', 'false');
create table inbounds (id integer primary key, up integer, down integer, total integer, remark text,
  enable integer, expiry_time integer, listen text, port integer, protocol text, settings text,
  stream_settings text, tag text, sniffing text, node_id integer);
insert into inbounds (remark, enable, listen, port, protocol, stream_settings, node_id, up, down) values
  (char(127465, 127466) || ' Германия: "Reality"', 1, '', 443, 'vless', '{"network":"tcp","security":"reality"}', 0, 100, 200),
  ('XHTTP', 1, '0.0.0.0', 8443, 'vless', '{"network":"xhttp"}', 0, 5, 6),
  ('выключен', 0, '', 9443, 'vmess', '{"network":"ws"}', 0, 0, 0),
  ('локальный', 1, '127.0.0.1', 10443, 'trojan', '{"network":"tcp"}', 0, 0, 0),
  ('SS', 1, '', 2443, 'shadowsocks', '{"network":"tcp"}', null, 0, 0),
  ('mKCP', 1, '', 3443, 'vless', '{"network":"KCP"}', 0, 0, 0),
  ('', 1, '', 4443, 'hysteria', '', 0, 0, 0),
  ('чужой узел', 1, '', 5443, 'vless', '{"network":"tcp"}', 3, 0, 0),
  ('dokodemo', 1, '', 6443, 'dokodemo-door', '{"network":"tcp"}', 0, 0, 0),
  ('v6 local', 1, '::1', 7443, 'vless', '{"network":"tcp"}', 0, 0, 0),
  ('', 1, '', 11443, 'wireguard', '{}', 0, 0, 0),
  ('внутренний адрес', 1, '10.0.0.5', 12443, 'vless', '{"network":"grpc"}', 0, 0, 0),
  ('Очень длинное имя inbound-а для проверки обрезки подписи', 1, '::', 13443, 'trojan', 'not json', 0, 0, 0),
  ('порт подписок', 1, '', 2096, 'vless', '{"network":"tcp"}', 0, 0, 0);
