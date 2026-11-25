-- Format numeru chipa jest osobnym polem; dotychczasowe numery pozostają bez zmian.
UPDATE access_categories
SET field_schema = '[{"key":"number_format","label":"Format numeru chipa","type":"select","options":["dziesiętnie","szesnastkowo"],"defaultValue":"dziesiętnie"},' || substr(field_schema, 2)
WHERE slug = 'chip';
