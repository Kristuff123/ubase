-- Migracja 3: znacznik ponownego potwierdzenia hasła w sesji.
-- Bramka do podejrzenia sekretów: reveal działa tylko, gdy hasło potwierdzono
-- w tym samym pliku cookie w ciągu ostatnich 5 minut — klient nie może tego sfabrykować.
ALTER TABLE sessions ADD COLUMN reauth_at INTEGER;
