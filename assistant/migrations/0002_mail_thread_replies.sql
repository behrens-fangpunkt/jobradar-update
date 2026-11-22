ALTER TABLE mail_threads ADD COLUMN has_reply INTEGER NOT NULL DEFAULT 0;

UPDATE mail_threads SET has_reply = 1 WHERE latest_inbound = 1;
