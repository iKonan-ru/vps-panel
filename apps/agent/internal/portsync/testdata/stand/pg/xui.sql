create table settings (id integer primary key, key text, value text);
insert into settings (key, value) values
  ('webPort', '54321'), ('webListen', '127.0.0.1'), ('webCertFile', '/root/cert.pem'),
  ('webKeyFile', '/root/key.pem'), ('webBasePath', '/secret/'), ('twoFactorEnable', 'TRUE'),
  ('subEnable', 'True'), ('subPort', '2097'), ('subListen', '127.0.0.1');
create table inbounds (id integer primary key, remark text, enable integer, listen text, port integer,
  protocol text, stream_settings text);
insert into inbounds (remark, enable, listen, port, protocol, stream_settings) values
  ('PG Reality', 1, '', 443, 'vless', '{"network":"tcp"}'),
  ('PG mixed', 1, '', 1080, 'mixed', '{"network":"tcp"}'),
  ('PG quic', 1, '', 8443, 'vmess', '{"network":"quic"}'),
  ('PG off', 0, '', 9443, 'vless', '{"network":"tcp"}');
