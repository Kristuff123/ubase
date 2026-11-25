-- Migracja 2: kategorie dostępów startowych (dane systemowe).
-- field_schema: lista pól; typy: text, password, select, multiselect, date, ref_org_unit, textarea.
INSERT INTO access_categories (slug, name, icon, field_schema, sort_order, is_system) VALUES
(
  'chip', 'Chip', 'chip',
  '[{"key":"number","label":"Numer chipa","type":"text","required":true},{"key":"level","label":"Poziom dostępu","type":"multiselect","required":true,"options":["piekarnia","cukiernia","biura","pierogarnia","alarm"]},{"key":"issued_at","label":"Data wydania","type":"date"}]',
  10, 1
),
(
  'axel', 'Axel', 'axel',
  '[{"key":"login","label":"Login","type":"text","required":true},{"key":"password","label":"Hasło","type":"password","required":true,"secret":true}]',
  20, 1
),
(
  'bclient', 'bClient', 'bclient',
  '[{"key":"login","label":"Login","type":"text","required":true},{"key":"password","label":"Hasło","type":"password","required":true,"secret":true},{"key":"store","label":"Sklep","type":"ref_org_unit","unitType":"sklep"}]',
  30, 1
),
(
  'remote', 'Dostęp zdalny', 'remote',
  '[{"key":"method","label":"Metoda","type":"select","required":true,"options":["VPN","RDP","TeamViewer","AnyDesk","inne"]},{"key":"login","label":"Login","type":"text"},{"key":"password","label":"Hasło","type":"password","secret":true},{"key":"note","label":"Notatka","type":"textarea"}]',
  40, 1
),
(
  'monitoring', 'Monitoring', 'monitoring',
  '[{"key":"scope","label":"Zakres","type":"select","required":true,"options":["region","zaklad","wszystkie"]},{"key":"region","label":"Region","type":"ref_org_unit","unitType":"region","showWhen":{"scope":["region"]}},{"key":"zaklad","label":"Zakład","type":"ref_org_unit","unitType":"zaklad","showWhen":{"scope":["zaklad"]}},{"key":"login","label":"Login","type":"text"},{"key":"password","label":"Hasło","type":"password","secret":true}]',
  50, 1
),
(
  'poczta', 'Poczta', 'mail',
  '[{"key":"account_type","label":"Typ konta","type":"select","required":true,"options":["firmowe","wspoldzielone","pracownika"]},{"key":"address","label":"Adres e-mail","type":"text","required":true},{"key":"password","label":"Hasło","type":"password","secret":true},{"key":"no_password","label":"Hasło znane tylko pracownikowi (reset przez panel)","type":"checkbox"},{"key":"recovery","label":"Kody odzyskiwania 2FA","type":"textarea","secret":true}]',
  60, 1
),
(
  'google', 'Google', 'google',
  '[{"key":"account_type","label":"Typ konta","type":"select","required":true,"options":["firmowe","wspoldzielone","pracownika"]},{"key":"address","label":"Adres e-mail","type":"text","required":true},{"key":"password","label":"Hasło","type":"password","secret":true},{"key":"no_password","label":"Hasło znane tylko pracownikowi (reset przez panel)","type":"checkbox"},{"key":"recovery","label":"Kody odzyskiwania 2FA","type":"textarea","secret":true}]',
  70, 1
),
(
  'inne', 'Inne', 'more',
  '[]',
  900, 1
);
