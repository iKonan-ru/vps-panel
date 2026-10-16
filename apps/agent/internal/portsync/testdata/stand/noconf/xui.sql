create table settings (key text, value text);
insert into settings values ('webPort', '2053'), ('webListen', '::'), ('webCertFile', '/c'),
  ('webKeyFile', ''), ('webBasePath', ''), ('subEnable', 'false'), ('subPort', '2096');
create table inbounds (remark text, enable integer, listen text, port integer, protocol text, stream_settings text);
insert into inbounds values
  ('Docker VLESS', 1, '', 443, 'vless', '{"network":"tcp"}'),
  ('Docker TUIC', 1, null, 8443, 'tuic', null);
